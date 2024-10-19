import type { TaskFunctionObject, WorkerChoiceStrategy, WorkerOptions } from "@poolifier/poolifier-web-worker"
import { KillBehaviors, WorkerChoiceStrategies } from "@poolifier/poolifier-web-worker"
import { isPlainObject } from "./utils.ts"

export const checkTaskFunctionName = (name: string): void => {
  if (typeof name !== 'string') {
    throw new TypeError('name parameter is not a string')
  }
  if (typeof name === 'string' && name.trim().length === 0) {
    throw new TypeError('name parameter is an empty string')
  }
}

export const checkValidWorkerOptions = (
  opts: WorkerOptions | undefined,
): void => {
  if (opts != null && !isPlainObject(opts)) {
    throw new TypeError('opts worker options parameter is not a plain object')
  }
  if (
    opts?.killBehavior != null &&
    !Object.values(KillBehaviors).includes(opts.killBehavior)
  ) {
    throw new TypeError(
      `killBehavior option '${opts.killBehavior}' is not valid`,
    )
  }
  if (
    opts?.maxInactiveTime != null &&
    !Number.isSafeInteger(opts.maxInactiveTime)
  ) {
    throw new TypeError('maxInactiveTime option is not an integer')
  }
  if (opts?.maxInactiveTime != null && opts.maxInactiveTime < 5) {
    throw new TypeError(
      'maxInactiveTime option is not a positive integer greater or equal than 5',
    )
  }
  if (opts?.killHandler != null && typeof opts.killHandler !== 'function') {
    throw new TypeError('killHandler option is not a function')
  }
}

export const checkValidPriority = (priority: number | undefined): void => {
  if (priority != null && !Number.isSafeInteger(priority)) {
    throw new TypeError(`Invalid property 'priority': '${priority.toString()}'`)
  }
  if (
    priority != null &&
    Number.isSafeInteger(priority) &&
    (priority < -20 || priority > 19)
  ) {
    throw new RangeError("Property 'priority' must be between -20 and 19")
  }
}

export const checkValidWorkerChoiceStrategy = (
  workerChoiceStrategy: WorkerChoiceStrategy | undefined,
): void => {
  if (
    workerChoiceStrategy != null &&
    !Object.values(WorkerChoiceStrategies).includes(workerChoiceStrategy)
  ) {
    throw new Error(`Invalid worker choice strategy '${workerChoiceStrategy}'`)
  }
}

export const checkValidTaskFunctionObjectEntry = <
  Data = unknown,
  Response = unknown,
>(
  name: string,
  fnObj: TaskFunctionObject<Data, Response>,
): void => {
  if (typeof name !== 'string') {
    throw new TypeError('A taskFunctions parameter object key is not a string')
  }
  if (typeof name === 'string' && name.trim().length === 0) {
    throw new TypeError(
      'A taskFunctions parameter object key is an empty string',
    )
  }
  if (typeof fnObj.taskFunction !== 'function') {
    throw new TypeError(
      `taskFunction object 'taskFunction' property '${fnObj.taskFunction}' is not a function`,
    )
  }
  checkValidPriority(fnObj.priority)
  checkValidWorkerChoiceStrategy(fnObj.strategy)
}