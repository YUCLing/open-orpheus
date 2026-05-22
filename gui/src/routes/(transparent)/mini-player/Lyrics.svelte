<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";

  import type { Lyrics } from "$sharedTypes/lyrics";

  let {
    time,
    lyrics,
    ...rest
  }: {
    time: number;
    lyrics: Lyrics;
  } & HTMLAttributes<HTMLDivElement> = $props();

  const timeMs = $derived(time * 1000);

  let containerWidth = $state(0);
  let textWidth = $state(0);

  // Derive the currently active line
  let currentLine = $derived.by(() => {
    if (!lyrics || lyrics.length === 0) return null;

    for (let i = lyrics.length - 1; i >= 0; i--) {
      if (timeMs >= lyrics[i].start_time) {
        return lyrics[i];
      }
    }

    return lyrics[0];
  });

  // Calculate the time progress of the current line (clamped between 0 and 1)
  let progress = $derived.by(() => {
    if (!currentLine) return 0;

    const { start_time, end_time } = currentLine;

    if (timeMs <= start_time) return 0;
    if (timeMs >= end_time) return 1;

    const duration = end_time - start_time;
    return duration > 0 ? (timeMs - start_time) / duration : 0;
  });

  // Calculate maximum scrollable distance and current offset
  let maxScroll = $derived(Math.max(0, textWidth - containerWidth));
  let offset = $derived(maxScroll * progress);
</script>

<div
  class="w-full overflow-hidden whitespace-nowrap"
  bind:clientWidth={containerWidth}
  {...rest}
>
  {#if currentLine}
    <div
      class="inline-block px-[2ch] will-change-transform"
      bind:clientWidth={textWidth}
      style="transform: translateX({-offset}px);"
    >
      {#each currentLine.words as word (word.start_time)}
        {word.text}
      {/each}
    </div>
  {/if}
</div>
