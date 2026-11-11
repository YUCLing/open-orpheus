<script lang="ts">
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Label } from "$lib/components/ui/label";
  import * as settings from "$lib/settings";

  let enabled = $state(false);
  let saving = $state(false);
  let message = $state("");
  const initialSettings = settings.get("discordPresence").then((value) => {
    enabled =
      typeof value === "object" && value !== null && "enabled" in value && value.enabled === true;
  });

  async function save(value: boolean) {
    const previous = enabled;
    enabled = value;
    saving = true;
    message = "";
    try {
      if (!(await settings.set("discordPresence", { enabled: value }))) {
        enabled = previous;
        message = "未能保存设置，请重试。";
      }
    } catch {
      enabled = previous;
      message = "未能保存设置，请重试。";
    } finally {
      saving = false;
    }
  }
</script>

<h1 class="text-2xl font-bold">Discord 听歌状态</h1>
<p class="mt-2 text-gray-700">
  启用后，Open Orpheus 会通过本机 Discord 桌面端分享正在播放的歌名、歌手和进度。请在 Discord
  中启用活动分享。
</p>

{#await initialSettings then}
  <div class="mt-4 grid max-w-md gap-3">
    <div class="flex items-center gap-2">
      <Checkbox
        id="discord-presence-enabled"
        bind:checked={() => enabled, save}
        disabled={saving}
      />
      <Label for="discord-presence-enabled">分享听歌状态</Label>
    </div>
    <p role="status" class="text-sm">{message}</p>
  </div>
{:catch}
  <p role="alert" class="mt-4">未能读取 Discord 听歌状态设置。</p>
{/await}
