import { DiscoveryService } from '@nestjs/core';

/**
 * The members' pictures, for `avatarUrl` of the access API's users, without
 * importing the module that keeps them (modules/attachments/avatars): that
 * module marks one provider `@MemberAvatars()`. Without one, nobody has a
 * picture (`avatarUrl: null`).
 */
export interface MemberAvatars {
  /** The picture's path of those of these users who have one. */
  avatarUrls(userIds: readonly string[]): Promise<Map<string, string>>;
}

/** Marks the provider that implements MemberAvatars (at most one). */
export const MemberAvatars = DiscoveryService.createDecorator<void>();
