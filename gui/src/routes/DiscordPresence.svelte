<script lang="ts">
  import { getBridge } from "$lib/bridge";
  import { Button } from "$lib/components/ui/button";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import type { ManageContract } from "@shared/contracts/manage-api";
  import { isDiscordApplicationId } from "@shared/discordPresence";

  const api = getBridge<ManageContract>("manage").discordPresence;
  let enabled = $state(false);
  let applicationId = $state("");
  let saving = $state(false);
  let message = $state("");
  const initialSettings = api.get().then((settings) => {
    enabled = settings.enabled;
    applicationId = settings.applicationId;
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const id = applicationId.trim();
    if ((enabled || id !== "") && !isDiscordApplicationId(id)) {
      message = "请输入有效的 Discord Application ID。";
      return;
    }

    saving = true;
    try {
      message = (await api.set({ enabled, applicationId: id })) ? "设置已保存。" : "未能保存设置。";
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
    <Label for="discord-application-id">Discord Application ID</Label>
    <Input
      id="discord-application-id"
      inputmode="numeric"
      bind:value={applicationId}
      disabled={saving}
      aria-describedby="discord-application-id-description"
    />
    <p id="discord-application-id-description" class="text-sm text-gray-700">
      在 <a
        class="underline"
        href="https://discord.com/developers/applications"
        target="_blank"
        rel="noreferrer">Discord 开发者后台</a
      >创建应用，从基本信息复制 Application ID。
    </p>
    <Button type="submit" class="w-fit" disabled={saving}>保存</Button>
    <p role="status" class="text-sm">{message}</p>
  </form>
{:catch}
  <p role="alert" class="mt-4">未能读取 Discord 听歌状态设置。</p>
{/await}
