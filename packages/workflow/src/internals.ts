import type { RawSourceMap } from 'source-map';
import {
  defaultFailureConverter,
  FailureConverter,
  PayloadConverter,
  arrayFromPayloads,
  defaultPayloadConverter,
  ensureTemporalFailure,
  IllegalStateError,
  TemporalFailure,
  Workflow,
  WorkflowExecutionAlreadyStartedError,
  WorkflowQueryType,
  WorkflowSignalType,
  WorkflowUpdateType,
  ProtoFailure,
  WorkflowUpdateValidatorType,
  ApplicationFailure,
} from '@temporalio/common';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { checkExtends } from '@temporalio/common/lib/type-helpers';
import type { coresdk } from '@temporalio/proto';
import { alea, RNG } from './alea';
import { RootCancellationScope } from './cancellation-scope';
import { DeterminismViolationError, LocalActivityDoBackoff, isCancellation } from './errors';
import { QueryInput, SignalInput, UpdateInput, WorkflowExecuteInput, WorkflowInterceptors } from './interceptors';
import {
  ContinueAsNew,
  DefaultSignalHandler,
  SDKInfo,
  FileSlice,
  EnhancedStackTrace,
  FileLocation,
  WorkflowInfo,
  WorkflowCreateOptionsInternal,
} from './interfaces';
import { type SinkCall } from './sinks';
import { untrackPromise } from './stack-helpers';
import pkg from './pkg';
import { executeWithLifecycleLogging } from './logs';

enum StartChildWorkflowExecutionFailedCause {
  START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_UNSPECIFIED = 0,
  START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_WORKFLOW_ALREADY_EXISTS = 1,
}

checkExtends<coresdk.child_workflow.StartChildWorkflowExecutionFailedCause, StartChildWorkflowExecutionFailedCause>();
checkExtends<StartChildWorkflowExecutionFailedCause, coresdk.child_workflow.StartChildWorkflowExecutionFailedCause>();

export interface Stack {
  formatted: string;
  structured: FileLocation[];
}

/**
 * Global store to track promise stacks for stack trace query
 */
export interface PromiseStackStore {
  childToParent: Map<Promise<unknown>, Set<Promise<unknown>>>;
  promiseToStack: Map<Promise<unknown>, Stack>;
}

export interface Completion {
  resolve(val: unknown): unknown;
  reject(reason: unknown): unknown;
}

export interface Condition {
  fn(): boolean;
  resolve(): void;
}

export type ActivationHandlerFunction<K extends keyof coresdk.workflow_activation.IWorkflowActivationJob> = (
  activation: NonNullable<coresdk.workflow_activation.IWorkflowActivationJob[K]>
) => void;

/**
 * Verifies all activation job handling methods are implemented
 */
export type ActivationHandler = {
  [P in keyof coresdk.workflow_activation.IWorkflowActivationJob]: ActivationHandlerFunction<P>;
};

/**
 * Keeps all of the Workflow runtime state like pending completions for activities and timers.
 *
 * Implements handlers for all workflow activation jobs.
 */
export class Activator implements ActivationHandler {
  /**
   * Cache for modules - referenced in reusable-vm.ts
   */
  readonly moduleCache = new Map<string, unknown>();
  /**
   * Map of task sequence to a Completion
   */
  readonly completions = {
    timer: new Map<number, Completion>(),
    activity: new Map<number, Completion>(),
    childWorkflowStart: new Map<number, Completion>(),
    childWorkflowComplete: new Map<number, Completion>(),
    signalWorkflow: new Map<number, Completion>(),
    cancelWorkflow: new Map<number, Completion>(),
  };

  /**
   * Holds buffered Update calls until a handler is registered
   */
  readonly bufferedUpdates = Array<coresdk.workflow_activation.IDoUpdate>();

  /**
   * Holds buffered signal calls until a handler is registered
   */
  readonly bufferedSignals = Array<coresdk.workflow_activation.ISignalWorkflow>();

  /**
   * Holds buffered query calls until a handler is registered.
   *
   * **IMPORTANT** queries are only buffered until workflow is started.
   * This is required because async interceptors might block workflow function invocation
   * which delays query handler registration.
   */
  protected readonly bufferedQueries = Array<coresdk.workflow_activation.IQueryWorkflow>();

  /**
   * Mapping of update name to handler and validator
   */
  readonly updateHandlers = new Map<string, { handler: WorkflowUpdateType; validator?: WorkflowUpdateValidatorType }>();

  /**
   * Mapping of signal name to handler
   */
  readonly signalHandlers = new Map<string, WorkflowSignalType>();

  /**
   * A signal handler that catches calls for non-registered signal names.
   */
  defaultSignalHandler?: DefaultSignalHandler;

  /**
   * Source map file for looking up the source files in response to __enhanced_stack_trace
   */
  protected readonly sourceMap: RawSourceMap;

  /**
   * Whether or not to send the sources in enhanced stack trace query responses
   */
  protected readonly showStackTraceSources;

  readonly promiseStackStore: PromiseStackStore = {
    promiseToStack: new Map(),
    childToParent: new Map(),
  };

  public readonly rootScope = new RootCancellationScope();

  /**
   * Mapping of query name to handler
   */
  public readonly queryHandlers = new Map<string, WorkflowQueryType>([
    [
      '__stack_trace',
      () => {
        return this.getStackTraces()
          .map((s) => s.formatted)
          .join('\n\n');
      },
    ],
    [
      '__enhanced_stack_trace',
      (): EnhancedStackTrace => {
        const { sourceMap } = this;
        const sdk: SDKInfo = { name: 'typescript', version: pkg.version };
        const stacks = this.getStackTraces().map(({ structured: locations }) => ({ locations }));
        const sources: Record<string, FileSlice[]> = {};
        if (this.showStackTraceSources) {
          for (const { locations } of stacks) {
            for (const { filePath } of locations) {
              if (!filePath) continue;
              const content = sourceMap?.sourcesContent?.[sourceMap?.sources.indexOf(filePath)];
              if (!content) continue;
              sources[filePath] = [
                {
                  content,
                  lineOffset: 0,
                },
              ];
            }
          }
        }
        return { sdk, stacks, sources };
      },
    ],
  ]);

  /**
   * Loaded in {@link initRuntime}
   */
  public readonly interceptors: Required<WorkflowInterceptors> = { inbound: [], outbound: [], internals: [] };

  /**
   * Buffer that stores all generated commands, reset after each activation
   */
  protected commands: coresdk.workflow_commands.IWorkflowCommand[] = [];

  /**
   * Stores all {@link condition}s that haven't been unblocked yet
   */
  public readonly blockedConditions = new Map<number, Condition>();

  /**
   * Is this Workflow completed?
   *
   * A Workflow will be considered completed if it generates a command that the
   * system considers as a final Workflow command (e.g.
   * completeWorkflowExecution or failWorkflowExecution).
   */
  public completed = false;

  /**
   * Was this Workflow cancelled?
   */
  protected cancelled = false;

  /**
   * This is tracked to allow buffering queries until a workflow function is called.
   * TODO(bergundy): I don't think this makes sense since queries run last in an activation and must be responded to in
   * the same activation.
   */
  protected workflowFunctionWasCalled = false;

  /**
   * The next (incremental) sequence to assign when generating completable commands
   */
  public nextSeqs = {
    timer: 1,
    activity: 1,
    childWorkflow: 1,
    signalWorkflow: 1,
    cancelWorkflow: 1,
    condition: 1,
    // Used internally to keep track of active stack traces
    stack: 1,
  };

  /**
   * This is set every time the workflow executes an activation
   */
  now: number;

  /**
   * Reference to the current Workflow, initialized when a Workflow is started
   */
  public workflow?: Workflow;

  /**
   * Information about the current Workflow
   */
  public info: WorkflowInfo;

  /**
   * A deterministic RNG, used by the isolate's overridden Math.random
   */
  public random: RNG;

  public payloadConverter: PayloadConverter = defaultPayloadConverter;
  public failureConverter: FailureConverter = defaultFailureConverter;

  /**
   * Patches we know the status of for this workflow, as in {@link patched}
   */
  public readonly knownPresentPatches = new Set<string>();

  /**
   * Patches we sent to core {@link patched}
   */
  public readonly sentPatches = new Set<string>();

  /**
   * Buffered sink calls per activation
   */
  sinkCalls = Array<SinkCall>();

  /**
   * A nanosecond resolution time function, externally injected
   */
  public readonly getTimeOfDay: () => bigint;

  public readonly registeredActivityNames: Set<string>;

  constructor({
    info,
    now,
    showStackTraceSources,
    sourceMap,
    getTimeOfDay,
    randomnessSeed,
    patches,
    registeredActivityNames,
  }: WorkflowCreateOptionsInternal) {
    this.getTimeOfDay = getTimeOfDay;
    this.info = info;
    this.now = now;
    this.showStackTraceSources = showStackTraceSources;
    this.sourceMap = sourceMap;
    this.random = alea(randomnessSeed);
    this.registeredActivityNames = registeredActivityNames;

    if (info.unsafe.isReplaying) {
      for (const patchId of patches) {
        this.notifyHasPatch({ patchId });
      }
    }
  }

  mutateWorkflowInfo(fn: (info: WorkflowInfo) => WorkflowInfo): void {
    this.info = fn(this.info);
  }

  protected getStackTraces(): Stack[] {
    const { childToParent, promiseToStack } = this.promiseStackStore;
    const internalNodes = [...childToParent.values()].reduce((acc, curr) => {
      for (const p of curr) {
        acc.add(p);
      }
      return acc;
    }, new Set());
    const stacks = new Map<string, Stack>();
    for (const child of childToParent.keys()) {
      if (!internalNodes.has(child)) {
        const stack = promiseToStack.get(child);
        if (!stack || !stack.formatted) continue;
        stacks.set(stack.formatted, stack);
      }
    }
    // Not 100% sure where this comes from, just filter it out
    stacks.delete('    at Promise.then (<anonymous>)');
    stacks.delete('    at Promise.then (<anonymous>)\n');
    return [...stacks].map(([_, stack]) => stack);
  }

  getAndResetSinkCalls(): SinkCall[] {
    const { sinkCalls } = this;
    this.sinkCalls = [];
    return sinkCalls;
  }

  /**
   * Buffer a Workflow command to be collected at the end of the current activation.
   *
   * Prevents commands from being added after Workflow completion.
   */
  pushCommand(cmd: coresdk.workflow_commands.IWorkflowCommand, complete = false): void {
    // Only query responses may be sent after completion
    if (this.completed && !cmd.respondToQuery) return;
    this.commands.push(cmd);
    if (complete) {
      this.completed = true;
    }
  }

  getAndResetCommands(): coresdk.workflow_commands.IWorkflowCommand[] {
    const commands = this.commands;
    this.commands = [];
    return commands;
  }

  public async startWorkflowNextHandler({ args }: WorkflowExecuteInput): Promise<any> {
    const { workflow } = this;
    if (workflow === undefined) {
      throw new IllegalStateError('Workflow uninitialized');
    }
    let promise: Promise<any>;
    try {
      promise = workflow(...args);
    } finally {
      // Queries must be handled even if there was an exception when invoking the Workflow function.
      this.workflowFunctionWasCalled = true;
      // Empty the buffer
      const buffer = this.bufferedQueries.splice(0);
      for (const activation of buffer) {
        this.queryWorkflow(activation);
      }
    }
    return await promise;
  }

  public startWorkflow(activation: coresdk.workflow_activation.IStartWorkflow): void {
    const execute = composeInterceptors(this.interceptors.inbound, 'execute', this.startWorkflowNextHandler.bind(this));

    untrackPromise(
      executeWithLifecycleLogging(() =>
        execute({
          headers: activation.headers ?? {},
          args: arrayFromPayloads(this.payloadConverter, activation.arguments),
        })
      ).then(this.completeWorkflow.bind(this), this.handleWorkflowFailure.bind(this))
    );
  }

  public cancelWorkflow(_activation: coresdk.workflow_activation.ICancelWorkflow): void {
    this.cancelled = true;
    this.rootScope.cancel();
  }

  public fireTimer(activation: coresdk.workflow_activation.IFireTimer): void {
    // Timers are a special case where their completion might not be in Workflow state,
    // this is due to immediate timer cancellation that doesn't go wait for Core.
    const completion = this.maybeConsumeCompletion('timer', getSeq(activation));
    completion?.resolve(undefined);
  }

  public resolveActivity(activation: coresdk.workflow_activation.IResolveActivity): void {
    if (!activation.result) {
      throw new TypeError('Got ResolveActivity activation with no result');
    }
    const { resolve, reject } = this.consumeCompletion('activity', getSeq(activation));
    if (activation.result.completed) {
      const completed = activation.result.completed;
      const result = completed.result ? this.payloadConverter.fromPayload(completed.result) : undefined;
      resolve(result);
    } else if (activation.result.failed) {
      const { failure } = activation.result.failed;
      const err = failure ? this.failureToError(failure) : undefined;
      reject(err);
    } else if (activation.result.cancelled) {
      const { failure } = activation.result.cancelled;
      const err = failure ? this.failureToError(failure) : undefined;
      reject(err);
    } else if (activation.result.backoff) {
      reject(new LocalActivityDoBackoff(activation.result.backoff));
    }
  }

  public resolveChildWorkflowExecutionStart(
    activation: coresdk.workflow_activation.IResolveChildWorkflowExecutionStart
  ): void {
    const { resolve, reject } = this.consumeCompletion('childWorkflowStart', getSeq(activation));
    if (activation.succeeded) {
      resolve(activation.succeeded.runId);
    } else if (activation.failed) {
      if (
        activation.failed.cause !==
        StartChildWorkflowExecutionFailedCause.START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_WORKFLOW_ALREADY_EXISTS
      ) {
        throw new IllegalStateError('Got unknown StartChildWorkflowExecutionFailedCause');
      }
      if (!(activation.seq && activation.failed.workflowId && activation.failed.workflowType)) {
        throw new TypeError('Missing attributes in activation job');
      }
      reject(
        new WorkflowExecutionAlreadyStartedError(
          'Workflow execution already started',
          activation.failed.workflowId,
          activation.failed.workflowType
        )
      );
    } else if (activation.cancelled) {
      if (!activation.cancelled.failure) {
        throw new TypeError('Got no failure in cancelled variant');
      }
      reject(this.failureToError(activation.cancelled.failure));
    } else {
      throw new TypeError('Got ResolveChildWorkflowExecutionStart with no status');
    }
  }

  public resolveChildWorkflowExecution(activation: coresdk.workflow_activation.IResolveChildWorkflowExecution): void {
    if (!activation.result) {
      throw new TypeError('Got ResolveChildWorkflowExecution activation with no result');
    }
    const { resolve, reject } = this.consumeCompletion('childWorkflowComplete', getSeq(activation));
    if (activation.result.completed) {
      const completed = activation.result.completed;
      const result = completed.result ? this.payloadConverter.fromPayload(completed.result) : undefined;
      resolve(result);
    } else if (activation.result.failed) {
      const { failure } = activation.result.failed;
      if (failure === undefined || failure === null) {
        throw new TypeError('Got failed result with no failure attribute');
      }
      reject(this.failureToError(failure));
    } else if (activation.result.cancelled) {
      const { failure } = activation.result.cancelled;
      if (failure === undefined || failure === null) {
        throw new TypeError('Got cancelled result with no failure attribute');
      }
      reject(this.failureToError(failure));
    }
  }

  // Intentionally non-async function so this handler doesn't show up in the stack trace
  protected queryWorkflowNextHandler({ queryName, args }: QueryInput): Promise<unknown> {
    const fn = this.queryHandlers.get(queryName);
    if (fn === undefined) {
      const knownQueryTypes = [...this.queryHandlers.keys()].join(' ');
      // Fail the query
      return Promise.reject(
        new ReferenceError(
          `Workflow did not register a handler for ${queryName}. Registered queries: [${knownQueryTypes}]`
        )
      );
    }
    try {
      const ret = fn(...args);
      if (ret instanceof Promise) {
        return Promise.reject(new DeterminismViolationError('Query handlers should not return a Promise'));
      }
      return Promise.resolve(ret);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  public queryWorkflow(activation: coresdk.workflow_activation.IQueryWorkflow): void {
    if (!this.workflowFunctionWasCalled) {
      this.bufferedQueries.push(activation);
      return;
    }

    const { queryType, queryId, headers } = activation;
    if (!(queryType && queryId)) {
      throw new TypeError('Missing query activation attributes');
    }

    const execute = composeInterceptors(
      this.interceptors.inbound,
      'handleQuery',
      this.queryWorkflowNextHandler.bind(this)
    );
    execute({
      queryName: queryType,
      args: arrayFromPayloads(this.payloadConverter, activation.arguments),
      queryId,
      headers: headers ?? {},
    }).then(
      (result) => this.completeQuery(queryId, result),
      (reason) => this.failQuery(queryId, reason)
    );
  }

  public doUpdate(activation: coresdk.workflow_activation.IDoUpdate): void {
    const { id: updateId, protocolInstanceId, name, headers, runValidator } = activation;
    if (!updateId) {
      throw new TypeError('Missing activation update id');
    }
    if (!name) {
      throw new TypeError('Missing activation update name');
    }
    if (!protocolInstanceId) {
      throw new TypeError('Missing activation update protocolInstanceId');
    }
    if (!this.updateHandlers.has(name)) {
      this.bufferedUpdates.push(activation);
      return;
    }

    const makeInput = (): UpdateInput => ({
      updateId,
      args: arrayFromPayloads(this.payloadConverter, activation.input),
      name,
      headers: headers ?? {},
    });

    // The implementation below is responsible for upholding, and constrained
    // by, the following contract:
    //
    // 1. If no validator is present then validation interceptors will not be run.
    //
    // 2. During validation, any error must fail the Update; during the Update
    //    itself, Temporal errors fail the Update whereas other errors fail the
    //    activation.
    //
    // 3. The handler must not see any mutations of the arguments made by the
    //    validator.
    //
    // 4. Any error when decoding/deserializing input must be caught and result
    //    in rejection of the Update before it is accepted, even if there is no
    //    validator.
    //
    // 5. The initial synchronous portion of the (async) Update handler should
    //    be executed after the (sync) validator completes such that there is
    //    minimal opportunity for a different concurrent task to be scheduled
    //    between them.
    //
    // 6. The stack trace view provided in the Temporal UI must not be polluted
    //    by promises that do not derive from user code. This implies that
    //    async/await syntax may not be used.
    //
    // Note that there is a deliberately unhandled promise rejection below.
    // These are caught elsewhere and fail the corresponding activation.
    let input: UpdateInput;
    try {
      if (runValidator && this.updateHandlers.get(name)?.validator) {
        const validate = composeInterceptors(
          this.interceptors.inbound,
          'validateUpdate',
          this.validateUpdateNextHandler.bind(this)
        );
        validate(makeInput());
      }
      input = makeInput();
    } catch (error) {
      this.rejectUpdate(protocolInstanceId, error);
      return;
    }
    const execute = composeInterceptors(this.interceptors.inbound, 'handleUpdate', this.updateNextHandler.bind(this));
    this.acceptUpdate(protocolInstanceId);
    untrackPromise(
      execute(input)
        .then((result) => this.completeUpdate(protocolInstanceId, result))
        .catch((error) => {
          if (error instanceof TemporalFailure) {
            this.rejectUpdate(protocolInstanceId, error);
          } else {
            throw error;
          }
        })
    );
  }

  protected async updateNextHandler({ name, args }: UpdateInput): Promise<unknown> {
    const entry = this.updateHandlers.get(name);
    if (!entry) {
      return Promise.reject(new IllegalStateError(`No registered update handler for update: ${name}`));
    }
    const { handler } = entry;
    return await handler(...args);
  }

  protected validateUpdateNextHandler({ name, args }: UpdateInput): void {
    const { validator } = this.updateHandlers.get(name) ?? {};
    if (validator) {
      validator(...args);
    }
  }

  public dispatchBufferedUpdates(): void {
    const bufferedUpdates = this.bufferedUpdates;
    while (bufferedUpdates.length) {
      const foundIndex = bufferedUpdates.findIndex((update) => this.updateHandlers.has(update.name as string));
      if (foundIndex === -1) {
        // No buffered Updates have a handler yet.
        break;
      }
      const [update] = bufferedUpdates.splice(foundIndex, 1);
      this.doUpdate(update);
    }
  }

  public rejectBufferedUpdates(): void {
    while (this.bufferedUpdates.length) {
      const update = this.bufferedUpdates.shift();
      if (update) {
        this.rejectUpdate(
          /* eslint-disable @typescript-eslint/no-non-null-assertion */
          update.protocolInstanceId!,
          ApplicationFailure.nonRetryable(`No registered handler for update: ${update.name}`)
        );
      }
    }
  }

  public async signalWorkflowNextHandler({ signalName, args }: SignalInput): Promise<void> {
    const fn = this.signalHandlers.get(signalName);
    if (fn) {
      return await fn(...args);
    } else if (this.defaultSignalHandler) {
      return await this.defaultSignalHandler(signalName, ...args);
    } else {
      throw new IllegalStateError(`No registered signal handler for signal: ${signalName}`);
    }
  }

  public signalWorkflow(activation: coresdk.workflow_activation.ISignalWorkflow): void {
    const { signalName, headers } = activation;
    if (!signalName) {
      throw new TypeError('Missing activation signalName');
    }

    if (!this.signalHandlers.has(signalName) && !this.defaultSignalHandler) {
      this.bufferedSignals.push(activation);
      return;
    }

    const execute = composeInterceptors(
      this.interceptors.inbound,
      'handleSignal',
      this.signalWorkflowNextHandler.bind(this)
    );
    execute({
      args: arrayFromPayloads(this.payloadConverter, activation.input),
      signalName,
      headers: headers ?? {},
    }).catch(this.handleWorkflowFailure.bind(this));
  }

  public dispatchBufferedSignals(): void {
    const bufferedSignals = this.bufferedSignals;
    while (bufferedSignals.length) {
      if (this.defaultSignalHandler) {
        // We have a default signal handler, so all signals are dispatchable
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.signalWorkflow(bufferedSignals.shift()!);
      } else {
        const foundIndex = bufferedSignals.findIndex((signal) => this.signalHandlers.has(signal.signalName as string));
        if (foundIndex === -1) break;
        const [signal] = bufferedSignals.splice(foundIndex, 1);
        this.signalWorkflow(signal);
      }
    }
  }

  public resolveSignalExternalWorkflow(activation: coresdk.workflow_activation.IResolveSignalExternalWorkflow): void {
    const { resolve, reject } = this.consumeCompletion('signalWorkflow', getSeq(activation));
    if (activation.failure) {
      reject(this.failureToError(activation.failure));
    } else {
      resolve(undefined);
    }
  }

  public resolveRequestCancelExternalWorkflow(
    activation: coresdk.workflow_activation.IResolveRequestCancelExternalWorkflow
  ): void {
    const { resolve, reject } = this.consumeCompletion('cancelWorkflow', getSeq(activation));
    if (activation.failure) {
      reject(this.failureToError(activation.failure));
    } else {
      resolve(undefined);
    }
  }

  public updateRandomSeed(activation: coresdk.workflow_activation.IUpdateRandomSeed): void {
    if (!activation.randomnessSeed) {
      throw new TypeError('Expected activation with randomnessSeed attribute');
    }
    this.random = alea(activation.randomnessSeed.toBytes());
  }

  public notifyHasPatch(activation: coresdk.workflow_activation.INotifyHasPatch): void {
    if (!activation.patchId) {
      throw new TypeError('Notify has patch missing patch name');
    }
    this.knownPresentPatches.add(activation.patchId);
  }

  public removeFromCache(): void {
    throw new IllegalStateError('removeFromCache activation job should not reach workflow');
  }

  /**
   * Transforms failures into a command to be sent to the server.
   * Used to handle any failure emitted by the Workflow.
   */
  async handleWorkflowFailure(error: unknown): Promise<void> {
    if (this.cancelled && isCancellation(error)) {
      this.pushCommand({ cancelWorkflowExecution: {} }, true);
    } else if (error instanceof ContinueAsNew) {
      this.pushCommand({ continueAsNewWorkflowExecution: error.command }, true);
    } else {
      if (!(error instanceof TemporalFailure)) {
        // This results in an unhandled rejection which will fail the activation
        // preventing it from completing.
        throw error;
      }

      this.pushCommand(
        {
          failWorkflowExecution: {
            failure: this.errorToFailure(error),
          },
        },
        true
      );
    }
  }

  private completeQuery(queryId: string, result: unknown): void {
    this.pushCommand({
      respondToQuery: { queryId, succeeded: { response: this.payloadConverter.toPayload(result) } },
    });
  }

  private failQuery(queryId: string, error: unknown): void {
    this.pushCommand({
      respondToQuery: {
        queryId,
        failed: this.errorToFailure(ensureTemporalFailure(error)),
      },
    });
  }

  private acceptUpdate(protocolInstanceId: string): void {
    this.pushCommand({ updateResponse: { protocolInstanceId, accepted: {} } });
  }

  private completeUpdate(protocolInstanceId: string, result: unknown): void {
    this.pushCommand({
      updateResponse: { protocolInstanceId, completed: this.payloadConverter.toPayload(result) },
    });
  }

  private rejectUpdate(protocolInstanceId: string, error: unknown): void {
    this.pushCommand({
      updateResponse: {
        protocolInstanceId,
        rejected: this.errorToFailure(ensureTemporalFailure(error)),
      },
    });
  }

  /** Consume a completion if it exists in Workflow state */
  private maybeConsumeCompletion(type: keyof Activator['completions'], taskSeq: number): Completion | undefined {
    const completion = this.completions[type].get(taskSeq);
    if (completion !== undefined) {
      this.completions[type].delete(taskSeq);
    }
    return completion;
  }

  /** Consume a completion if it exists in Workflow state, throws if it doesn't */
  private consumeCompletion(type: keyof Activator['completions'], taskSeq: number): Completion {
    const completion = this.maybeConsumeCompletion(type, taskSeq);
    if (completion === undefined) {
      throw new IllegalStateError(`No completion for taskSeq ${taskSeq}`);
    }
    return completion;
  }

  private completeWorkflow(result: unknown): void {
    this.pushCommand(
      {
        completeWorkflowExecution: {
          result: this.payloadConverter.toPayload(result),
        },
      },
      true
    );
  }

  errorToFailure(err: unknown): ProtoFailure {
    return this.failureConverter.errorToFailure(err, this.payloadConverter);
  }

  failureToError(failure: ProtoFailure): Error {
    return this.failureConverter.failureToError(failure, this.payloadConverter);
  }
}

function getSeq<T extends { seq?: number | null }>(activation: T): number {
  const seq = activation.seq;
  if (seq === undefined || seq === null) {
    throw new TypeError(`Got activation with no seq attribute`);
  }
  return seq;
}
