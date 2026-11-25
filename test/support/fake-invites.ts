// An InviteProvider that answers from memory, so the window handlers can be driven into
// states Discord will not produce on request.
//
// The failure modes it can be asked for are the ones that matter: refusing outright
// (the work row must stay queued), and reporting an expiry LATER than the window's end,
// which is what clock skew between our server and Discord's looks like from here.

import type {
  CreateInviteInput, DeleteOutcome, InviteProvider, IssuedInvite,
} from '../../src/access.ts';
import { InviteProviderError } from '../../src/access.ts';

export interface FakeInviteOptions {
  /** When set, createInvite rejects with an InviteProviderError carrying this message. */
  failCreateWith?: string;
  /** When set, deleteInvite rejects with an InviteProviderError carrying this message. */
  failDeleteWith?: string;
  /**
   * What deleteInvite reports. Defaults to `deleted`, the only confirmed removal.
   * Against the real API with minimal permissions the answer is always `unknown`.
   */
  deleteOutcome?: DeleteOutcome;
  /**
   * The instant expiry is measured from. Defaults to the wall clock, which is wrong for
   * any test that pins its own `now`: the code would expire relative to today rather
   * than to the test's fixed date.
   */
  now?: Date;
  /** Added to the reported expiry, to model Discord's clock running ahead of ours. */
  skewSeconds?: number;
}

export class FakeInviteProvider implements InviteProvider {
  created: CreateInviteInput[] = [];
  deleted: string[] = [];
  private readonly options: FakeInviteOptions;
  private counter = 0;

  constructor(options: FakeInviteOptions = {}) {
    this.options = options;
  }

  async createInvite(input: CreateInviteInput): Promise<IssuedInvite> {
    this.created.push(input);
    if (this.options.failCreateWith !== undefined) {
      throw new InviteProviderError(this.options.failCreateWith);
    }
    this.counter += 1;
    const code = `fakecode${this.counter}`;
    const from = this.options.now ?? new Date();
    const skew = (this.options.skewSeconds ?? 0) * 1_000;
    return {
      code,
      url: `https://discord.gg/${code}`,
      expiresAt: new Date(from.getTime() + input.maxAgeSeconds * 1_000 + skew),
    };
  }

  async deleteInvite(code: string): Promise<DeleteOutcome> {
    this.deleted.push(code);
    if (this.options.failDeleteWith !== undefined) {
      throw new InviteProviderError(this.options.failDeleteWith);
    }
    return this.options.deleteOutcome ?? 'deleted';
  }
}
