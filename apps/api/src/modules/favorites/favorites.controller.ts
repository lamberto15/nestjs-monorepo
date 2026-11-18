import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type CreateFavoriteDto,
  createFavoriteSchema,
  favoriteListSchema,
  favoriteSchema,
  MAX_FAVORITES,
  type ReorderFavoritesDto,
  reorderFavoritesSchema,
} from './favorites.schemas.js';
import { FavoritesService } from './favorites.service.js';

/**
 * The caller's favorites: records and pages pinned for quick navigation, in
 * their order. Anyone signed in keeps their own; a record is pinned and
 * listed only while they can read it.
 */
@ApiTags('favorites')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Each person's own; what a favorite points at is checked against their permissions.
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  @ApiOperation({
    summary: 'Your favorites',
    description:
      'In your order. A record you no longer see (deleted, or your access changed) is left out.',
  })
  @ApiOkResponse({ standardSchema: favoriteListSchema })
  list(@CurrentUser() user: Principal) {
    return this.favorites.list(user);
  }

  @Post()
  @ApiOperation({
    summary: 'Pin a record or a page',
    description: `Last in your list. \`kind\`: \`record\` (with its \`subject\`, \`Note\`, and its id as \`target\`) or \`page\` (the app's path: \`/notes\`) or \`view\` (its id as \`target\`, the list page it opens on as \`subject\`: \`/notes\`). At most ${MAX_FAVORITES}.`,
  })
  @ApiCreatedResponse({ standardSchema: favoriteSchema })
  @ApiBadRequestResponse({
    description: `A malformed favorite, or ${MAX_FAVORITES} already (validation_failed).`,
  })
  @ApiNotFoundResponse({
    description: 'No such record, or you may not see it.',
  })
  @ApiConflictResponse({ description: 'It is a favorite already.' })
  add(
    @CurrentUser() user: Principal,
    @Body({ schema: createFavoriteSchema }) dto: CreateFavoriteDto,
  ) {
    return this.favorites.add(user, dto);
  }

  @Put('order')
  @ApiOperation({
    summary: 'Reorder your favorites',
    description: 'Every one of your favorites, by id, in the new order.',
  })
  @ApiOkResponse({ standardSchema: favoriteListSchema })
  @ApiBadRequestResponse({
    description:
      'Not every one of your favorites, once each (validation_failed).',
  })
  reorder(
    @CurrentUser() user: Principal,
    @Body({ schema: reorderFavoritesSchema }) dto: ReorderFavoritesDto,
  ) {
    return this.favorites.reorder(user, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unpin a favorite' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Not one of your favorites.' })
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.favorites.remove(user, id);
  }
}
