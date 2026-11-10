<script lang="ts">
  import { getBridge } from "$lib/bridge";
  import { Button } from "$lib/components/ui/button";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Label } from "$lib/components/ui/label";
  import type { ManageContract } from "@shared/contracts/manage-api";

  const api = getBridge<ManageContract>("manage").discordPresence;
  let enabled = $state(false);
  let saving = $state(false);
  let message = $state("");
  const initialSettings = api.get().then((settings) => {
    enabled = settings.enabled;
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    try {
      message = (await api.set({ enabled })) ? "设置已保存。" : "未能保存设置。";
    } catch {
      message = "未能保存设置。";
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

{#await initialSettings}
  <p class="mt-4">正在读取设置…</p>
{:then}
  <form class="mt-4 grid max-w-md gap-3" onsubmit={save}>
    <div class="flex items-center gap-2">
      <Checkbox id="discord-presence-enabled" bind:checked={enabled} disabled={saving} />
      <Label for="discord-presence-enabled">分享听歌状态</Label>
    </div>
    <Button type="submit" class="w-fit" disabled={saving}>保存</Button>
    <p role="status" class="text-sm">{message}</p>
  </form>
{:catch}
  <p role="alert" class="mt-4">未能读取 Discord 听歌状态设置。</p>
{/await}
