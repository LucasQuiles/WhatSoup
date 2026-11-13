// Moved verbatim out of runtime.ts to keep that file under its recorded size ceiling.
export class AgentCommandRuntimeError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'AgentCommandRuntimeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
