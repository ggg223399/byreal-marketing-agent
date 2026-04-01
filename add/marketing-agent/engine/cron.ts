import cron from 'node-cron';
import type { SourceConfig } from './types.js';

/**
 * 代表一个已注册的定时任务。
 * - `name`：对应 source 的名称，用于日志标识
 * - `schedule`：cron 表达式字符串
 * - `task`：node-cron 返回的可控任务实例
 */
export interface CronJob {
  name: string;
  schedule: string;
  task: cron.ScheduledTask;
}

/**
 * 校验 cron 表达式是否合法。
 * @param expression cron 表达式字符串
 * @returns 合法返回 true，否则返回 false
 */
export function validateCronExpression(expression: string): boolean {
  return cron.validate(expression);
}

/**
 * 根据 sources 配置批量构建定时任务列表。
 * 每个 source 对应一个独立的 cron 任务，初始状态为未启动（scheduled: false）。
 * 任务执行时若 handler 抛出异常，会捕获并打印错误日志，不影响其他任务。
 * @param sources  source 配置数组
 * @param handler  每次触发时执行的异步处理函数，接收对应的 source 配置
 * @returns 构建好的 CronJob 数组（尚未启动）
 */
export function buildCronJobs(
  sources: SourceConfig[],
  handler: (source: SourceConfig) => Promise<void>
): CronJob[] {
  return sources.map(source => {
    // 提前校验 cron 表达式，防止运行时静默失败
    if (!cron.validate(source.schedule)) {
      throw new Error(`Invalid cron expression for source "${source.name}": ${source.schedule}`);
    }

    // 创建任务但不立即启动，由 startAllJobs 统一控制启动时机
    const task = cron.schedule(source.schedule, () => {
      handler(source).catch(err => {
        // 捕获异步错误，避免未处理的 Promise rejection 导致进程崩溃
        console.error(`[cron] Error in source "${source.name}":`, err);
      });
    }, { scheduled: false } as any);

    return { name: source.name, schedule: source.schedule, task };
  });
}

/**
 * 启动所有已构建的定时任务。
 * 启动后任务将按各自的 cron 表达式自动触发。
 * @param jobs 由 `buildCronJobs` 返回的任务数组
 */
export function startAllJobs(jobs: CronJob[]): void {
  for (const job of jobs) {
    job.task.start();
    console.log(`[cron] Started "${job.name}" with schedule: ${job.schedule}`);
  }
}

/**
 * 停止所有正在运行的定时任务。
 * 通常在进程退出或配置热重载前调用。
 * @param jobs 需要停止的任务数组
 */
export function stopAllJobs(jobs: CronJob[]): void {
  for (const job of jobs) {
    job.task.stop();
  }
  console.log(`[cron] Stopped ${jobs.length} jobs`);
}
