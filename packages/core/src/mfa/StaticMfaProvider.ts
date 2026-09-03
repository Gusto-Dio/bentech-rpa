import type { MfaCodeProvider, MfaCodeRequest } from './MfaCodeProvider.ts';

/** Returns a fixed code. Tests only; records what was asked for. */
export class StaticMfaProvider implements MfaCodeProvider {
  readonly name = 'static';
  readonly requests: MfaCodeRequest[] = [];

  readonly #code: string;

  constructor(code = '123456') {
    this.#code = code;
  }

  async waitForCode(request: MfaCodeRequest): Promise<string> {
    this.requests.push(request);
    return this.#code;
  }
}
