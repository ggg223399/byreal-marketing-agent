import type { RoutingConfig, RouteMatch, ProcessedSignal } from './types.js';

/**
 * 判断信号的某个字段值是否匹配路由规则中的期望值。
 * 支持单值匹配（字符串）和多值匹配（字符串数组）。
 * @param signalValue 信号中的实际字段值
 * @param matchValue  路由规则中配置的期望值（单个字符串或字符串数组）
 */
function matchesField(signalValue: string, matchValue: string | string[]): boolean {
  if (Array.isArray(matchValue)) {
    // 数组模式：信号值在允许列表内即匹配
    return matchValue.includes(signalValue);
  }
  return signalValue === matchValue;
}

/**
 * 判断一条信号是否满足给定的路由匹配规则。
 * 目前支持 alertLevel 和 suggestedAction 两个维度，
 * 两个维度同时存在时取交集（AND 逻辑）。
 * @param signal 已处理的信号对象
 * @param match  路由规则中的 match 或 match_not 条件
 */
function matchesRule(signal: ProcessedSignal, match: RouteMatch): boolean {
  if (match.alertLevel !== undefined) {
    if (!matchesField(signal.alertLevel, match.alertLevel)) return false;
  }
  if (match.suggestedAction !== undefined) {
    if (!matchesField(signal.suggestedAction, match.suggestedAction)) return false;
  }
  return true;
}

/**
 * 根据路由配置计算信号应该推送到哪些渠道。
 *
 * 匹配逻辑：
 * - 遍历 `config.routing.routes`，按顺序逐条评估
 * - `match` 条件：信号满足该条件时命中
 * - `match_not` 条件：信号不满足该条件时命中
 * - `match` + `match_not` 同时存在：两者都要满足（AND）
 * - 命中后将该路由的 `channel` 加入结果列表
 * - 若路由未设置 `continue: true`，命中后立即停止遍历（短路）
 * - 若最终没有任何路由命中，使用 `routing.default.channel` 作为兜底
 *
 * @param signal 已处理的信号对象
 * @param config 路由配置
 * @returns 目标渠道名称数组（至少包含一个元素）
 */
export function resolveChannels(signal: ProcessedSignal, config: RoutingConfig): string[] {
  const channels: string[] = [];

  for (const route of config.routing.routes) {
    let matched = false;

    if (route.match) {
      matched = matchesRule(signal, route.match);
    }

    if (route.match_not) {
      const notMatched = matchesRule(signal, route.match_not);
      // match 和 match_not 同时存在时：match 命中且 match_not 不命中才算最终匹配
      if (route.match) {
        matched = matched && !notMatched;
      } else {
        // 仅有 match_not：信号不满足 match_not 条件即命中
        matched = !notMatched;
      }
    }

    if (matched) {
      channels.push(route.channel);
      // 未设置 continue 时短路，避免重复路由到多个渠道
      if (!route.continue) {
        break;
      }
    }
  }

  // 没有任何规则命中，降级到默认渠道
  if (channels.length === 0) {
    channels.push(config.routing.default.channel);
  }

  return channels;
}
