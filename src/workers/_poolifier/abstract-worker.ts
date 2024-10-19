
import type { WorkerOptions, TaskFunctionObject, WorkerStatistics, TaskFunction, TaskFunctions, TaskFunctionOperationResult, TaskFunctionProperties, MessageValue, TaskAsyncFunction, TaskSyncFunction, TaskPerformance, Task } from '@poolifier/poolifier-web-worker'

import {
  buildTaskFunctionProperties,
  DEFAULT_TASK_NAME,
  EMPTY_FUNCTION,
  isAsyncFunction,
  isPlainObject,
} from '../../utils/utils.ts'
import {
  checkTaskFunctionName,
  checkValidTaskFunctionObjectEntry,
  checkValidWorkerOptions,
} from '../../utils/checks.ts'
import { KillBehaviors } from '@poolifier/poolifier-web-worker'
import { getTransferables, isSupported } from '@okikio/transferables'

const features = await isSupported();

const DEFAULT_MAX_INACTIVE_TIME = 60000
const DEFAULT_WORKER_OPTIONS: WorkerOptions = {
  /**
   * The kill behavior option on this worker or its default value.
   */
  killBehavior: KillBehaviors.SOFT,
  /**
   * The maximum time to keep this worker active while idle.
   * The pool automatically checks and terminates this worker when the time expires.
   */
  maxInactiveTime: DEFAULT_MAX_INACTIVE_TIME,
  /**
   * The function to call when the worker is killed.
   */
  killHandler: EMPTY_FUNCTION,
}

/**
 * Base class that implements some shared logic for all poolifier workers.
 *
 * @typeParam MainWorker - Type of main worker.
 * @typeParam Data - Type of data this worker receives from pool's execution. This can only be structured-cloneable data.
 * @typeParam Response - Type of response the worker sends back to the main worker. This can only be structured-cloneable data.
 */
export abstract class AbstractWorker<
  MainWorker extends WorkerGlobalScope & typeof globalThis,
  Data = unknown,
  Response = unknown,
> {
  /**
   * Worker id.
   */
  protected abstract id?: `${string}-${string}-${string}-${string}-${string}`
  /**
   * Task function(s) object processed by the worker when the pool's `execute` method is invoked.
   */
  protected taskFunctions!: Map<string, TaskFunctionObject<Data, Response>>
  /**
   * Timestamp of the last task processed by this worker.
   */
  protected lastTaskTimestamp!: number
  /**
   * Performance statistics computation requirements.
   */
  protected statistics?: WorkerStatistics
  /**
   * Handler id of the `activeInterval` worker activity check.
   */
  protected activeInterval?: number

  /**
   * Constructs a new poolifier worker.
   * @param isMain - Whether this is the main worker or not.
   * @param mainWorker - Reference to main worker.
   * @param taskFunctions - Task function(s) processed by the worker when the pool's `execute` method is invoked. The first function is the default function.
   * @param opts - Options for the worker.
   */
  public constructor(
    private readonly isMain: boolean | undefined,
    private readonly mainWorker: MainWorker | undefined,
    taskFunctions: TaskFunction<Data, Response> | TaskFunctions<Data, Response>,
    protected opts: WorkerOptions = DEFAULT_WORKER_OPTIONS,
  ) {
    if (this.isMain == null) {
      throw new Error('isMain parameter is mandatory')
    }
    this.checkTaskFunctions(taskFunctions)
    this.checkWorkerOptions(this.opts)
    if (!this.isMain) {
      this.getMainWorker().addEventListener(
        'message',
        this.handleReadyMessageEvent.bind(this),
        {
          once: true,
        },
      )
    }
  }

  private checkWorkerOptions(opts: WorkerOptions): void {
    checkValidWorkerOptions(opts)
    this.opts = { ...DEFAULT_WORKER_OPTIONS, ...opts }
  }

  /**
   * Checks if the `taskFunctions` parameter is passed to the constructor and valid.
   *
   * @param taskFunctions - The task function(s) parameter that should be checked.
   */
  private checkTaskFunctions(
    taskFunctions:
      | TaskFunction<Data, Response>
      | TaskFunctions<Data, Response>
      | undefined,
  ): void {
    if (taskFunctions == null) {
      throw new Error('taskFunctions parameter is mandatory')
    }
    this.taskFunctions = new Map<string, TaskFunctionObject<Data, Response>>()
    if (typeof taskFunctions === 'function') {
      const fnObj = { taskFunction: taskFunctions.bind(this) }
      this.taskFunctions.set(DEFAULT_TASK_NAME, fnObj)
      this.taskFunctions.set(
        typeof taskFunctions.name === 'string' &&
          taskFunctions.name.trim().length > 0
          ? taskFunctions.name
          : 'fn1',
        fnObj,
      )
    } else if (isPlainObject(taskFunctions)) {
      let firstEntry = true
      for (let [name, fnObj] of Object.entries(taskFunctions)) {
        if (typeof fnObj === 'function') {
          fnObj = { taskFunction: fnObj } satisfies TaskFunctionObject<
            Data,
            Response
          >
        }
        checkValidTaskFunctionObjectEntry<Data, Response>(name, fnObj)
        fnObj.taskFunction = fnObj.taskFunction.bind(this)
        if (firstEntry) {
          this.taskFunctions.set(DEFAULT_TASK_NAME, fnObj)
          firstEntry = false
        }
        this.taskFunctions.set(name, fnObj)
      }
      if (firstEntry) {
        throw new Error('taskFunctions parameter object is empty')
      }
    } else {
      throw new TypeError(
        'taskFunctions parameter is not a function or a plain object',
      )
    }
  }

  /**
   * Checks if the worker has a task function with the given name.
   *
   * @param name - The name of the task function to check.
   * @returns Whether the worker has a task function with the given name or not.
   */
  public hasTaskFunction(name: string): TaskFunctionOperationResult {
    try {
      checkTaskFunctionName(name)
    } catch (error) {
      return { status: false, error: error as Error }
    }
    return { status: this.taskFunctions.has(name) }
  }

  /**
   * Adds a task function to the worker.
   * If a task function with the same name already exists, it is replaced.
   *
   * @param name - The name of the task function to add.
   * @param fn - The task function to add.
   * @returns Whether the task function was added or not.
   */
  public addTaskFunction(
    name: string,
    fn: TaskFunction<Data, Response> | TaskFunctionObject<Data, Response>,
  ): TaskFunctionOperationResult {
    try {
      checkTaskFunctionName(name)
      if (name === DEFAULT_TASK_NAME) {
        throw new Error(
          'Cannot add a task function with the default reserved name',
        )
      }
      if (typeof fn === 'function') {
        fn = { taskFunction: fn } satisfies TaskFunctionObject<Data, Response>
      }
      checkValidTaskFunctionObjectEntry<Data, Response>(name, fn)
      fn.taskFunction = fn.taskFunction.bind(this)
      if (
        this.taskFunctions.get(name) ===
        this.taskFunctions.get(DEFAULT_TASK_NAME)
      ) {
        this.taskFunctions.set(DEFAULT_TASK_NAME, fn)
      }
      this.taskFunctions.set(name, fn)
      this.sendTaskFunctionsPropertiesToMainWorker()
      return { status: true }
    } catch (error) {
      return { status: false, error: error as Error }
    }
  }

  /**
   * Removes a task function from the worker.
   *
   * @param name - The name of the task function to remove.
   * @returns Whether the task function existed and was removed or not.
   */
  public removeTaskFunction(name: string): TaskFunctionOperationResult {
    try {
      checkTaskFunctionName(name)
      if (name === DEFAULT_TASK_NAME) {
        throw new Error(
          'Cannot remove the task function with the default reserved name',
        )
      }
      if (
        this.taskFunctions.get(name) ===
        this.taskFunctions.get(DEFAULT_TASK_NAME)
      ) {
        throw new Error(
          'Cannot remove the task function used as the default task function',
        )
      }
      const deleteStatus = this.taskFunctions.delete(name)
      this.sendTaskFunctionsPropertiesToMainWorker()
      return { status: deleteStatus }
    } catch (error) {
      return { status: false, error: error as Error }
    }
  }

  /**
   * Lists the properties of the worker's task functions.
   *
   * @returns The properties of the worker's task functions.
   */
  public listTaskFunctionsProperties(): TaskFunctionProperties[] {
    let defaultTaskFunctionName = DEFAULT_TASK_NAME
    for (const [name, fnObj] of this.taskFunctions) {
      if (
        name !== DEFAULT_TASK_NAME &&
        fnObj === this.taskFunctions.get(DEFAULT_TASK_NAME)
      ) {
        defaultTaskFunctionName = name
        break
      }
    }
    const taskFunctionsProperties: TaskFunctionProperties[] = []
    for (const [name, fnObj] of this.taskFunctions) {
      if (name === DEFAULT_TASK_NAME || name === defaultTaskFunctionName) {
        continue
      }
      taskFunctionsProperties.push(buildTaskFunctionProperties(name, fnObj))
    }
    return [
      buildTaskFunctionProperties(
        DEFAULT_TASK_NAME,
        this.taskFunctions.get(DEFAULT_TASK_NAME),
      ),
      buildTaskFunctionProperties(
        defaultTaskFunctionName,
        this.taskFunctions.get(defaultTaskFunctionName),
      ),
      ...taskFunctionsProperties,
    ]
  }

  /**
   * Sets the default task function to use in the worker.
   *
   * @param name - The name of the task function to use as default task function.
   * @returns Whether the default task function was set or not.
   */
  public setDefaultTaskFunction(name: string): TaskFunctionOperationResult {
    try {
      checkTaskFunctionName(name)
      if (name === DEFAULT_TASK_NAME) {
        throw new Error(
          'Cannot set the default task function reserved name as the default task function',
        )
      }
      if (!this.taskFunctions.has(name)) {
        throw new Error(
          'Cannot set the default task function to a non-existing task function',
        )
      }
      this.taskFunctions.set(
        DEFAULT_TASK_NAME,
        this.taskFunctions.get(name) as TaskFunctionObject<Data, Response>,
      )
      this.sendTaskFunctionsPropertiesToMainWorker()
      return { status: true }
    } catch (error) {
      return { status: false, error: error as Error }
    }
  }

  /**
   * Handles the ready message event sent by the main worker.
   *
   * @param messageEvent - The ready message event.
   */
  protected abstract handleReadyMessageEvent(
    messageEvent: MessageEvent<MessageValue<Data>>,
  ): void

  /**
   * Worker message event listener.
   *
   * @param messageEvent - The received message event.
   */
  protected messageEventListener(
    messageEvent: MessageEvent<MessageValue<Data>>,
  ): void {
    const { data } = messageEvent
    this.checkMessageWorkerId(data)
    const { statistics, checkActive, taskFunctionOperation, taskId, kill } =
      data
    if (statistics != null) {
      // Statistics message received
      this.statistics = statistics
    } else if (checkActive != null) {
      // Check active message received
      checkActive ? this.startCheckActive() : this.stopCheckActive()
    } else if (taskFunctionOperation != null) {
      // Task function operation message received
      this.handleTaskFunctionOperationMessage(data)
    } else if (taskId != null && data != null) {
      // Task message received
      this.run(data)
    } else if (kill === true) {
      // Kill message received
      this.handleKillMessage(data)
    }
  }

  protected handleTaskFunctionOperationMessage(
    message: MessageValue<Data>,
  ): void {
    const { taskFunctionOperation, taskFunctionProperties, taskFunction } =
      message
    if (taskFunctionProperties == null) {
      throw new Error(
        'Cannot handle task function operation message without task function properties',
      )
    }
    let response: TaskFunctionOperationResult
    switch (taskFunctionOperation) {
      case 'add':
        if (typeof taskFunction !== 'string') {
          throw new Error(
            `Cannot handle task function operation ${taskFunctionOperation} message without task function`,
          )
        }
        response = this.addTaskFunction(taskFunctionProperties.name, {
          taskFunction: new Function(
            `return ${taskFunction}`,
          )() as TaskFunction<Data, Response>,
          ...(taskFunctionProperties.priority != null && {
            priority: taskFunctionProperties.priority,
          }),
          ...(taskFunctionProperties.strategy != null && {
            strategy: taskFunctionProperties.strategy,
          }),
        })
        break
      case 'remove':
        response = this.removeTaskFunction(taskFunctionProperties.name)
        break
      case 'default':
        response = this.setDefaultTaskFunction(taskFunctionProperties.name)
        break
      default:
        response = {
          status: false,
          error: new Error('Unknown task operation'),
        }
        break
    }
    const { status, error } = response
    this.sendToMainWorker({
      taskFunctionOperation,
      taskFunctionOperationStatus: status,
      taskFunctionProperties,
      ...(!status &&
        error != null && {
        workerError: {
          name: taskFunctionProperties.name,
          message: this.handleError(error as Error | string),
        },
      }),
    })
  }

  /**
   * Handles a kill message sent by the main worker.
   *
   * @param _message - The kill message.
   */
  protected handleKillMessage(_message: MessageValue<Data>): void {
    this.stopCheckActive()
    if (isAsyncFunction(this.opts.killHandler)) {
      ; (this.opts.killHandler as () => Promise<void>)()
        .then(() => {
          this.sendToMainWorker({ kill: 'success' })
        })
        .catch(() => {
          this.sendToMainWorker({ kill: 'failure' })
        })
    } else {
      try {
        ; (this.opts.killHandler as (() => void) | undefined)?.()
        this.sendToMainWorker({ kill: 'success' })
      } catch {
        this.sendToMainWorker({ kill: 'failure' })
      }
    }
  }

  /**
   * Check if the message worker id is set and matches the worker id.
   *
   * @param message - The message to check.
   * @throws {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error} If the message worker id is not set or does not match the worker id.
   */
  private checkMessageWorkerId(message: MessageValue<Data>): void {
    if (message.workerId == null) {
      throw new Error('Message worker id is not set')
    } else if (message.workerId !== this.id) {
      throw new Error(
        `Message worker id ${message.workerId.toString()} does not match the worker id ${this.id}`,
      )
    }
  }

  /**
   * Starts the worker check active interval.
   */
  private startCheckActive(): void {
    this.lastTaskTimestamp = performance.now()
    this.activeInterval = setInterval(
      this.checkActive.bind(this),
      (this.opts.maxInactiveTime ?? DEFAULT_MAX_INACTIVE_TIME) / 2,
    )
  }

  /**
   * Stops the worker check active interval.
   */
  private stopCheckActive(): void {
    if (this.activeInterval != null) {
      clearInterval(this.activeInterval)
      delete this.activeInterval
    }
  }

  /**
   * Checks if the worker should be terminated, because its living too long.
   */
  private checkActive(): void {
    if (
      performance.now() - this.lastTaskTimestamp >
      (this.opts.maxInactiveTime ?? DEFAULT_MAX_INACTIVE_TIME)
    ) {
      this.sendToMainWorker({ kill: this.opts.killBehavior })
    }
  }

  /**
   * Returns the main worker.
   *
   * @returns Reference to the main worker.
   * @throws {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error} If the main worker is not set.
   */
  protected getMainWorker(): MainWorker {
    if (this.mainWorker == null) {
      throw new Error('Main worker not set')
    }
    return this.mainWorker
  }

  /**
   * Sends a message to main worker.
   *
   * @param message - The response message.
   */
  protected abstract sendToMainWorker(
    message: MessageValue<Response, Data>,
    transferables?: Transferable[]
  ): void

  /**
   * Sends task functions properties to the main worker.
   */
  protected sendTaskFunctionsPropertiesToMainWorker(): void {
    this.sendToMainWorker({
      taskFunctionsProperties: this.listTaskFunctionsProperties(),
    })
  }

  /**
   * Handles an error and convert it to a string so it can be sent back to the main worker.
   *
   * @param error - The error raised by the worker.
   * @returns The error message.
   */
  protected handleError(error: Error | string): string {
    return error instanceof Error ? error.message : error
  }

  /**
   * Runs the given task.
   *
   * @param task - The task to execute.
   */
  protected readonly run = (task: Task<Data>): void => {
    const { name, taskId, data } = task
    const taskFunctionName = name ?? DEFAULT_TASK_NAME
    if (!this.taskFunctions.has(taskFunctionName)) {
      this.sendToMainWorker({
        workerError: {
          name: name!,
          message: `Task function '${name!}' not found`,
          data,
        },
        taskId,
      })
      return
    }
    const fn = this.taskFunctions.get(taskFunctionName)?.taskFunction
    if (isAsyncFunction(fn)) {
      this.runAsync(fn as TaskAsyncFunction<Data, Response>, task)
    } else {
      this.runSync(fn as TaskSyncFunction<Data, Response>, task)
    }
  }

  /**
   * Runs the given task function synchronously.
   *
   * @param fn - Task function that will be executed.
   * @param task - Input data for the task function.
   */
  protected readonly runSync = (
    fn: TaskSyncFunction<Data, Response>,
    task: Task<Data>,
  ): void => {
    const { name, taskId, data } = task
    try {
      let taskPerformance = this.beginTaskPerformance(name)
      const res = fn(data)
      taskPerformance = this.endTaskPerformance(taskPerformance)

      const transferables = getTransferables(res, features.streams)
      this.sendToMainWorker({
        data: res,
        taskPerformance,
        taskId,
      }, transferables)
    } catch (error) {
      this.sendToMainWorker({
        workerError: {
          name: name!,
          message: this.handleError(error as Error | string),
          data,
        },
        taskId,
      })
    } finally {
      this.updateLastTaskTimestamp()
    }
  }

  /**
   * Runs the given task function asynchronously.
   *
   * @param fn - Task function that will be executed.
   * @param task - Input data for the task function.
   */
  protected readonly runAsync = (
    fn: TaskAsyncFunction<Data, Response>,
    task: Task<Data>,
  ): void => {
    const { name, taskId, data } = task
    let taskPerformance = this.beginTaskPerformance(name)
    fn(data)
      .then((res) => {
        taskPerformance = this.endTaskPerformance(taskPerformance)
        this.sendToMainWorker({
          data: res,
          taskPerformance,
          taskId,
        })
      })
      .catch((error) => {
        this.sendToMainWorker({
          workerError: {
            name: name!,
            message: this.handleError(error as Error | string),
            data,
          },
          taskId,
        })
      })
      .finally(() => {
        this.updateLastTaskTimestamp()
      })
      .catch(EMPTY_FUNCTION)
  }

  private beginTaskPerformance(name?: string): TaskPerformance {
    if (this.statistics == null) {
      throw new Error('Performance statistics computation requirements not set')
    }
    return {
      name: name ?? DEFAULT_TASK_NAME,
      timestamp: performance.now(),
      // ...(this.statistics.elu && { elu: performance.eventLoopUtilization() }),
    }
  }

  private endTaskPerformance(
    taskPerformance: TaskPerformance,
  ): TaskPerformance {
    if (this.statistics == null) {
      throw new Error('Performance statistics computation requirements not set')
    }
    return {
      ...taskPerformance,
      ...(this.statistics.runTime && {
        runTime: performance.now() - taskPerformance.timestamp,
      }),
      // ...(this.statistics.elu && {
      //   elu: performance.eventLoopUtilization(taskPerformance.elu),
      // }),
    }
  }

  private updateLastTaskTimestamp(): void {
    if (this.activeInterval != null) {
      this.lastTaskTimestamp = performance.now()
    }
  }
}
