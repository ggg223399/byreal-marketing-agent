import Database from 'better-sqlite3';
import type { AlertLevel, Approval, ApprovalAction, Signal, SignalCategory } from '../types/index.js';
export declare function getDb(): Database.Database;
export declare function closeDb(): void;
export interface InsertSignalInput {
    tweetId: string;
    author: string;
    content: string;
    url?: string;
    category: SignalCategory;
    confidence: number;
    relevance: number;
    sentiment?: string;
    priority?: number;
    riskLevel?: string;
    suggestedAction?: string;
    alertLevel: AlertLevel;
    sourceAdapter: string;
    rawJson?: string;
}
export declare function insertSignal(input: InsertSignalInput): Signal;
export declare function getSignalById(id: number): Signal | null;
export declare function getPendingSignals(limit?: number): Signal[];
export declare function getUnnotifiedSignals(limit?: number): Signal[];
export declare function getSignalsSince(epochSeconds: number): Signal[];
export declare function markSignalNotified(signalId: number): void;
export interface RecordApprovalInput {
    signalId: number;
    action: ApprovalAction;
    draftText?: string;
    finalText?: string;
    approvedBy?: string;
}
export declare function recordApproval(input: RecordApprovalInput): Approval;
export declare function logAudit(actionType: string, details?: Record<string, unknown>): void;
export declare function getConfigOverride(key: string): string | undefined;
export declare function setConfigOverride(key: string, value: string): void;
export declare function getRateLimit(counterType: string, windowStart: number): number;
export declare function incrementRateLimit(counterType: string, windowStart: number, windowEnd: number, by?: number): number;
//# sourceMappingURL=index.d.ts.map