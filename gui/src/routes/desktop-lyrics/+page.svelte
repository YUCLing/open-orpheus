<script lang="ts" module>
  declare const desktopLyrics: {
    dragWindow: () => void;
  };
</script>

<div
  role="button"
  tabindex="0"
  class="flex cursor-grab flex-col items-center gap-4 rounded p-4 hover:bg-black/40"
  onmousedown={(e) => {
    e.preventDefault();
    desktopLyrics.dragWindow();
  }}
>
  <div>
    <!-- TODO: Controls -->
  </div>
  <div class="flex-1">
    <h1>Hello World!</h1>
  </div>
</div>
