export const DISPOSITIONS = Object.freeze([
  'retry',
  'replan',
  'needs-user',
  'needs-permission',
  'invalid',
  'bug',
]);

export class ToolError extends Error {
  constructor(code, message, disposition, details) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.disposition = disposition;
    this.details = details;
  }
}

export function invalid(code, message, details) {
  return new ToolError(code, message, 'invalid', details);
}
