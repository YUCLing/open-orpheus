<script lang="ts">
  import { getBridge } from "$lib/bridge";
  import type { ColorPickerContract } from "@shared/contracts/color-picker-api";
  import iro from "@jaames/iro";
  import { onMount } from "svelte";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";

  const api = getBridge<ColorPickerContract>("picker");

  let iroContainer: HTMLDivElement | undefined = $state();
  let iroPicker: iro.ColorPicker | undefined;
  let hexColor: string = $state("#ffffff");

  let debounceTimer: NodeJS.Timeout | undefined = undefined;

  $effect(() => {
    void hexColor;
    if (iroPicker && iroPicker.color.hexString !== hexColor) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (!iroPicker) return;
        iroPicker.color.hexString = hexColor;
      }, 500);
    }
  });

  onMount(async () => {
    const picker = (iroPicker = iro.ColorPicker(iroContainer!, {
      color: await api.initialValue(),
    }));
    picker.on("color:change", (value: iro.Color) => {
      hexColor = value.hexString;
    });
    hexColor = picker.color.hexString;
  });
</script>

<svelte:head>
  <title>颜色选择</title>
</svelte:head>

<div class="flex h-screen w-screen flex-col items-center justify-evenly p-4">
  <div bind:this={iroContainer}></div>
  <div class="mt-4 flex w-full gap-2">
    <Input type="text" bind:value={hexColor} spellcheck={false} />
    <Button
      onclick={() => {
        const clr = iroPicker?.color;
        if (!clr) return;
        api.save({
          hexString: clr.hexString as `#${string}`,
          rgb: clr.rgb,
          hsl: clr.hsl,
        });
      }}>确定</Button
    >
  </div>
</div>
