import {
  ColorPicker,
  ColorPickerArea,
  ColorPickerContent,
  ColorPickerHueSlider,
  ColorPickerInput,
} from '@nestjs-monorepo/ui/components/color-picker';
import { useRef } from 'react';

/**
 * Dice UI's color picker on a hex color. It passes the color through HSV when
 * it mounts and reports the rounded result (`#ef4444` comes back as
 * `#f04343`), which would recolour a tag the user only opened: so its changes
 * count from the first pointer, key or input event on it, and it starts from
 * `value` (uncontrolled: the parent remounts it for another color).
 */
export function HexPicker(props: {
  value: string;
  onChange: (hex: string) => void;
}) {
  const touched = useRef(false);
  const touch = () => {
    touched.current = true;
  };
  return (
    <div
      onPointerDownCapture={touch}
      onKeyDownCapture={touch}
      onChangeCapture={touch}
    >
      <ColorPicker
        inline
        format="hex"
        defaultValue={props.value}
        onValueChange={(next) => touched.current && props.onChange(next)}
      >
        <ColorPickerContent className="w-full p-0">
          <ColorPickerArea />
          <ColorPickerHueSlider />
          <ColorPickerInput withoutAlpha />
        </ColorPickerContent>
      </ColorPicker>
    </div>
  );
}
