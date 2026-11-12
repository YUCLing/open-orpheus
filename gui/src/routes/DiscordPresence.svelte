<script lang="ts">
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Label } from "$lib/components/ui/label";
  import * as settings from "$lib/settings";

  let enabledPromise = $state(settings.get("discordPresence.enabled"));
</script>

<h1 class="text-2xl font-bold">Discord 听歌状态</h1>
<p class="mt-2 text-gray-700">
  启用后，Open Orpheus 会通过本机 Discord 桌面端分享正在播放的歌名、歌手和进度。请在 Discord
  中启用活动分享。
</p>

{#await enabledPromise then enabled}
  <div class="mt-4 grid max-w-md gap-3">
    <div class="flex items-center gap-2">
      <Checkbox
        id="discord-presence-enabled"
        bind:checked={
          () => enabled === true,
          (value) => {
            const checked = value === true;
            settings.set("discordPresence.enabled", checked);
            enabledPromise = Promise.resolve(checked);
          }
        }
      />
      <Label for="discord-presence-enabled">分享听歌状态</Label>
    </div>
  </div>
{/await}
