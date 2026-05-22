#!/usr/bin/env node
import { type RetinueLogAuditResult } from "../core/logAudit.js";
export declare function main(args?: string[], env?: NodeJS.ProcessEnv): Promise<void>;
export declare function renderCompactAuditResult(result: RetinueLogAuditResult): string;
