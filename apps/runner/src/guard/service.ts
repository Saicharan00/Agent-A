import type { GuardTerm, Repos } from '@agenta/db';
import {
  type GuardCheckResponse,
  type GuardFinding,
  type GuardTermCreateInput,
  type GuardTermView,
  checkConfidential,
  describeFindings,
  guardTermViewSchema,
  redactFindings,
} from '@agenta/shared';

type Log = { warn(obj: object, msg?: string): void };

export class GuardError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** Uploads bigger than this are not scanned (logs, datasets); the composer caps attachments well below it. */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

const toView = (t: GuardTerm): GuardTermView => guardTermViewSchema.parse(t);

/**
 * Confidentiality guard (F24). Guard terms stay in the local DB: they are only matched here and never rendered
 * into prompts or instruction files.
 */
export class GuardService {
  constructor(private readonly opts: { repos: Repos; log: Log }) {}

  check(text: string): GuardCheckResponse {
    const findings = this.find(text);
    return { findings, redacted: redactFindings(text, findings) };
  }

  /** Findings in an uploaded text file; binary and very large files are not scanned. */
  checkUpload(data: Buffer): GuardFinding[] {
    if (data.length > MAX_SCAN_BYTES || data.subarray(0, 8192).includes(0)) return [];
    return this.find(data.toString('utf8'));
  }

  /**
   * Refuses a flagged upload unless the owner chose "Upload anyway", which is logged (kinds only, never the text).
   */
  guardUpload(data: Buffer, allowFlagged: boolean, where: Record<string, string>): void {
    const findings = this.checkUpload(data);
    if (!findings.length) return;
    if (allowFlagged) return this.logOverride('upload', findings, where);
    throw new GuardError(
      'guard_blocked',
      describeFindings(findings, 'Remove it from the file, or upload anyway.'),
      422,
    );
  }

  /** "Send anyway": the owner overrode the guard. Logged without the matched text. */
  logOverride(what: string, findings: GuardFinding[], where: Record<string, string>): void {
    this.opts.log.warn(
      { ...where, kinds: [...new Set(findings.map((f) => f.kind))] },
      `guard override: ${what}`,
    );
  }

  find(text: string): GuardFinding[] {
    return checkConfidential(text, this.opts.repos.guardTerms.list());
  }

  listTerms(): GuardTermView[] {
    return this.opts.repos.guardTerms.list().map(toView);
  }

  createTerm(input: GuardTermCreateInput): GuardTermView {
    return toView(this.opts.repos.guardTerms.create(input));
  }

  deleteTerm(id: string): void {
    if (!this.opts.repos.guardTerms.delete(id))
      throw new GuardError('not_found', `Guard term ${id} not found`, 404);
  }
}
