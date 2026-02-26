import {
  getSignalById,
  getRateLimit,
  incrementRateLimit,
  logAudit,
  recordApproval,
  type RecordApprovalInput,
} from '../db/index.js';
import { isAlreadyApproved } from '../governance/filters.js';
import type { CollectorConfig } from '../types/index.js';

function getHourWindow(ts: number): { start: number; end: number } {
  const start = Math.floor(ts / 3600) * 3600;
  return { start, end: start + 3600 };
}

function getDayWindow(ts: number): { start: number; end: number } {
  const d = new Date(ts * 1000);
  const start = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
  return { start, end: start + 86400 };
}

export function canApproveSignal(config: CollectorConfig, nowTs = Math.floor(Date.now() / 1000)): {
  allowed: boolean;
  reason?: string;
} {
  const hourWindow = getHourWindow(nowTs);
  const dayWindow = getDayWindow(nowTs);

  const hourCount = getRateLimit('approve_per_hour', hourWindow.start);
  if (hourCount >= config.governance.maxRepliesPerHour) {
    return { allowed: false, reason: 'Hourly approval limit exceeded' };
  }

  const dayCount = getRateLimit('approve_per_day', dayWindow.start);
  if (dayCount >= config.governance.maxRepliesPerDay) {
    return { allowed: false, reason: 'Daily approval limit exceeded' };
  }

  return { allowed: true };
}

function assertSignalReady(signalId: number): void {
  const signal = getSignalById(signalId);
  if (!signal) {
    throw new Error(`Signal #${signalId} not found`);
  }
  if (isAlreadyApproved(signalId)) {
    throw new Error(`Signal #${signalId} is already approved`);
  }
}

function markApprovalRateLimit(nowTs = Math.floor(Date.now() / 1000)): void {
  const hourWindow = getHourWindow(nowTs);
  const dayWindow = getDayWindow(nowTs);
  incrementRateLimit('approve_per_hour', hourWindow.start, hourWindow.end, 1);
  incrementRateLimit('approve_per_day', dayWindow.start, dayWindow.end, 1);
}

export function approveSignal(
  signalId: number,
  draftText: string,
  finalText: string,
  approvedBy: string,
  config: CollectorConfig,
  nowTs = Math.floor(Date.now() / 1000)
): void {
  assertSignalReady(signalId);

  const check = canApproveSignal(config, nowTs);
  if (!check.allowed) {
    throw new Error(check.reason || 'Approval blocked by governance limit');
  }

  const input: RecordApprovalInput = {
    signalId,
    action: 'approve',
    draftText,
    finalText,
    approvedBy,
  };
  recordApproval(input);
  markApprovalRateLimit(nowTs);
  logAudit('signal_approved', { signalId, approvedBy });
}

export function editAndApproveSignal(
  signalId: number,
  draftText: string,
  editedText: string,
  approvedBy: string,
  config: CollectorConfig,
  nowTs = Math.floor(Date.now() / 1000)
): void {
  assertSignalReady(signalId);

  const check = canApproveSignal(config, nowTs);
  if (!check.allowed) {
    throw new Error(check.reason || 'Approval blocked by governance limit');
  }

  const input: RecordApprovalInput = {
    signalId,
    action: 'edit',
    draftText,
    finalText: editedText,
    approvedBy,
  };
  recordApproval(input);
  markApprovalRateLimit(nowTs);
  logAudit('signal_approved_edit', { signalId, approvedBy });
}

export function rejectSignal(signalId: number, approvedBy: string, reason?: string): void {
  const signal = getSignalById(signalId);
  if (!signal) {
    throw new Error(`Signal #${signalId} not found`);
  }

  recordApproval({
    signalId,
    action: 'reject',
    approvedBy,
    finalText: reason,
  });
  logAudit('signal_rejected', { signalId, approvedBy, reason: reason ?? null });
}
