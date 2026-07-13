export class ChangeSetError extends Error {
  constructor(code, message, disposition = 'replan', details) {
    super(message);
    this.name = 'ChangeSetError';
    this.code = code;
    this.disposition = disposition;
    this.details = details;
  }
}

export function replan(code, message, details) {
  return new ChangeSetError(code, message, 'replan', details);
}

export function invalid(code, message, details) {
  return new ChangeSetError(code, message, 'invalid', details);
}
