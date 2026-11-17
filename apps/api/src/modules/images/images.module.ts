import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { ImageProcessor } from './image-processor.js';
import { imagesConfig } from './images.config.js';

/** Exports `ImageProcessor`: thumbnails, previews and metadata stripping on sharp. */
@Module({
  imports: [ConfigModule.forFeature(imagesConfig)],
  providers: [
    {
      provide: ImageProcessor,
      inject: [imagesConfig.KEY],
      useFactory: (config: ConfigType<typeof imagesConfig>) =>
        new ImageProcessor(config),
    },
  ],
  exports: [ImageProcessor],
})
export class ImagesModule {}
