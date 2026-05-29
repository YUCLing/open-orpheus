<script lang="ts">
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Label } from "$lib/components/ui/label";

  import * as settings from "$lib/settings";

  let interpolatedLyricLinePromise = $state(
    settings.get("desktopLyrics.interpolatedLyricLine") as Promise<
      boolean | undefined
    >
  );
</script>

<h1 class="text-2xl font-bold">桌面歌词</h1>
<p class="mt-2 text-gray-700">深入定制 Open Orpheus 桌面歌词的行为。</p>

{#await interpolatedLyricLinePromise then interpolatedLyricLine}
  <Label
    class="mt-4 flex items-start gap-3 rounded-lg border p-3 hover:bg-accent/50 has-aria-checked:border-blue-600 has-aria-checked:bg-blue-50 dark:has-aria-checked:border-blue-900 dark:has-aria-checked:bg-blue-950"
  >
    <Checkbox
      id="toggle-2"
      bind:checked={
        () => interpolatedLyricLine ?? true,
        (v) => {
          settings.set("desktopLyrics.interpolatedLyricLine", v);
          interpolatedLyricLinePromise = Promise.resolve(v);
        }
      }
      class="data-[state=checked]:border-blue-600 data-[state=checked]:bg-blue-600 data-[state=checked]:text-white dark:data-[state=checked]:border-blue-700 dark:data-[state=checked]:bg-blue-700"
    />
    <div class="grid gap-1.5 font-normal">
      <p class="text-sm leading-none font-medium">
        启用桌面歌词逐行插值进度显示
      </p>
      <p class="text-sm text-muted-foreground">
        启用后，当没有逐字歌词可用时，Open Orpheus
        将会根据当前一行歌词时间显示当前一行歌词的进度。
      </p>
    </div>
  </Label>
{/await}
