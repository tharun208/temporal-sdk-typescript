import { randomUUID } from 'crypto';
import { ErrorConstructor, ExecutionContext, TestFn } from 'ava';
import {
  WorkflowFailedError,
  WorkflowHandle,
  WorkflowStartOptions,
  WorkflowUpdateFailedError,
} from '@temporalio/client';
import {
  LocalTestWorkflowEnvironmentOptions,
  TestWorkflowEnvironment,
  workflowInterceptorModules as defaultWorkflowInterceptorModules,
} from '@temporalio/testing';
import {
  DefaultLogger,
  LogLevel,
  Runtime,
  WorkerOptions,
  WorkflowBundle,
  bundleWorkflowCode,
} from '@temporalio/worker';
import * as workflow from '@temporalio/workflow';
import { ConnectionInjectorInterceptor } from './activities/interceptors';
import { Worker, test as anyTest, bundlerOptions } from './helpers';

export interface Context {
  env: TestWorkflowEnvironment;
  workflowBundle: WorkflowBundle;
}

export function makeTestFunction(opts: {
  workflowsPath: string;
  workflowEnvironmentOpts?: LocalTestWorkflowEnvironmentOptions;
  workflowInterceptorModules?: string[];
}): TestFn<Context> {
  const test = anyTest as TestFn<Context>;
  test.before(async (t) => {
    // Ignore invalid log levels
    Runtime.install({ logger: new DefaultLogger((process.env.TEST_LOG_LEVEL || 'DEBUG').toUpperCase() as LogLevel) });
    const env = await TestWorkflowEnvironment.createLocal(opts.workflowEnvironmentOpts);
    const workflowBundle = await bundleWorkflowCode({
      ...bundlerOptions,
      workflowInterceptorModules: [...defaultWorkflowInterceptorModules, ...(opts.workflowInterceptorModules ?? [])],
      workflowsPath: opts.workflowsPath,
    });
    t.context = {
      env,
      workflowBundle,
    };
  });
  test.after.always(async (t) => {
    await t.context.env.teardown();
  });
  return test;
}

export interface Helpers {
  taskQueue: string;
  createWorker(opts?: Partial<WorkerOptions>): Promise<Worker>;
  executeWorkflow<T extends () => Promise<any>>(workflowType: T): Promise<workflow.WorkflowResultType<T>>;
  executeWorkflow<T extends workflow.Workflow>(
    fn: T,
    opts: Omit<WorkflowStartOptions<T>, 'taskQueue' | 'workflowId'>
  ): Promise<workflow.WorkflowResultType<T>>;
  startWorkflow<T extends () => Promise<any>>(workflowType: T): Promise<WorkflowHandle<T>>;
  startWorkflow<T extends workflow.Workflow>(
    fn: T,
    opts: Omit<WorkflowStartOptions<T>, 'taskQueue' | 'workflowId'>
  ): Promise<WorkflowHandle<T>>;
  assertWorkflowUpdateFailed(p: Promise<any>, causeConstructor: ErrorConstructor, message?: string): Promise<void>;
  assertWorkflowFailedError(p: Promise<any>, causeConstructor: ErrorConstructor, message?: string): Promise<void>;
}

export function helpers(t: ExecutionContext<Context>): Helpers {
  const taskQueue = t.title.replace(/ /g, '_');

  return {
    taskQueue,
    async createWorker(opts?: Partial<WorkerOptions>): Promise<Worker> {
      return await Worker.create({
        connection: t.context.env.nativeConnection,
        workflowBundle: t.context.workflowBundle,
        taskQueue,
        interceptors: {
          activity: [() => ({ inbound: new ConnectionInjectorInterceptor(t.context.env.connection) })],
        },
        showStackTraceSources: true,
        ...opts,
      });
    },
    async executeWorkflow(
      fn: workflow.Workflow,
      opts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'>
    ): Promise<any> {
      return await t.context.env.client.workflow.execute(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...opts,
      });
    },
    async startWorkflow(
      fn: workflow.Workflow,
      opts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'>
    ): Promise<WorkflowHandle<workflow.Workflow>> {
      return await t.context.env.client.workflow.start(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...opts,
      });
    },
    async assertWorkflowUpdateFailed(
      p: Promise<any>,
      causeConstructor: ErrorConstructor,
      message?: string
    ): Promise<void> {
      const err: WorkflowUpdateFailedError = (await t.throwsAsync(p, {
        instanceOf: WorkflowUpdateFailedError,
      })) as WorkflowUpdateFailedError;
      t.true(err.cause instanceof causeConstructor);
      if (message !== undefined) {
        t.is(err.cause?.message, message);
      }
    },
    async assertWorkflowFailedError(
      p: Promise<any>,
      causeConstructor: ErrorConstructor,
      message?: string
    ): Promise<void> {
      const err: WorkflowFailedError = (await t.throwsAsync(p, {
        instanceOf: WorkflowFailedError,
      })) as WorkflowFailedError;
      t.true(err.cause instanceof causeConstructor);
      if (message !== undefined) {
        t.is(err.cause?.message, message);
      }
    },
  };
}
