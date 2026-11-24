import { forwardRef, Inject } from '@nestjs/common';
import { Policy } from '@nestjs/authorization';
import type { Principal } from '../../iam/auth/principal.js';
import * as service from './lists.service.js';
import type { ListsService } from './lists.service.js';

/**
 * Who may read a subject's list description (GET /v1/lists/{subject}):
 * whoever may read the subject, on any of its records (the list route
 * itself answers them; others get an empty list there, a 403 here), or,
 * for the users' list, whoever may open the access API.
 */
@Policy()
export class ListPolicy {
  // ListsService authorizes with this policy, so each file imports the other:
  // the service is named lazily, never read while the files load.
  constructor(
    @Inject(forwardRef(() => service.ListsService))
    private readonly lists: ListsService,
  ) {}

  read(user: Principal | null, subject: string) {
    return this.lists.mayRead(user, subject);
  }
}
