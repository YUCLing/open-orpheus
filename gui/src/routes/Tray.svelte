<script lang="ts">
  import * as RadioGroup from "$lib/components/ui/radio-group";
  import * as Field from "$lib/components/ui/field";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { getBridge } from "$lib/bridge";
  import type {
    ManageContract,
    TrayLyricsExtensionInfo,
    TrayLyricsStyle,
  } from "$bridge/manage-api";

  const api = getBridge<ManageContract>("manage");

  type TrayClickBehavior =
    | "depends-on-main-window"
    | "always-show-menu"
    | "with-native-menu";

  let clickBehaviorPromise = $state(kv.get("tray.clickBehavior"));
  let trayLyricsEnabledPromise = $state(kv.get("trayLyrics.enabled"));
  let extensionInfoPromise = $state(
    api.platform === "linux"
      ? api.trayLyrics.getExtensionInfo()
      : Promise.resolve({
          installed: false,
          recognized: false,
          enabled: false,
          version: null,
          upToDate: false,
          needsSessionRestart: false,
        })
  );
  let extensionInstallPromise = $state<
    ReturnType<ManageContract["trayLyrics"]["installExtension"]> | null
  >(null);
  let extensionInstalling = $state(false);
  let trayLyricsStyleDraft = $state<TrayLyricsStyle>({
    fontFamily: "",
    color: "",
  });
  let trayLyricsStylePromise = $state(loadTrayLyricsStyle());
  let systemFontsPromise = $state(api.trayLyrics.getSystemFonts());
  let trayLyricsStyleSaving = $state(false);

  function normalizeColor(value: string) {
    const color = value.trim();
    if (color === "") return "";

    const hexColor = color.startsWith("#") ? color : `#${color}`;
    const shortHex = hexColor.match(/^#([0-9a-fA-F]{3})$/);
    if (shortHex) {
      return `#${shortHex[1]
        .split("")
        .map((part) => part + part)
        .join("")
        .toLowerCase()}`;
    }

    return /^#[0-9a-fA-F]{6}$/.test(hexColor) ? hexColor.toLowerCase() : "";
  }

  function getColorPickerValue(color: string) {
    return normalizeColor(color) || "#ffffff";
  }

  function getExtensionButtonText(info: TrayLyricsExtensionInfo) {
    if (!info.installed) return "安装并开启";
    if (!info.upToDate) return "更新并启用";
    if (!info.recognized || info.enabled) return "已安装";

    return "启用扩展";
  }

  function canInstallOrEnableExtension(info: TrayLyricsExtensionInfo) {
    if (!info.installed || !info.upToDate) return true;
    if (!info.recognized) return false;

    return !info.enabled;
  }

  function loadTrayLyricsStyle() {
    return api.trayLyrics.getStyle().then((style) => {
      trayLyricsStyleDraft = { ...style };
      return style;
    });
  }

  function setTrayLyricsEnabled(enabled: boolean) {
    const value = enabled ? "true" : "false";
    kv.set("trayLyrics.enabled", value);
    trayLyricsEnabledPromise = Promise.resolve(value);
  }

  function installTrayLyricsExtension() {
    extensionInstalling = true;
    extensionInstallPromise = api.trayLyrics
      .installExtension()
      .then((result) => {
        extensionInfoPromise = api.trayLyrics.getExtensionInfo();
        if (result.enabled) setTrayLyricsEnabled(true);
        return result;
      })
      .finally(() => {
        extensionInstalling = false;
      });
  }

  function setTrayLyricsStyle(style: TrayLyricsStyle) {
    trayLyricsStyleSaving = true;
    trayLyricsStylePromise = api.trayLyrics
      .setStyle({
        fontFamily: style.fontFamily,
        color: normalizeColor(style.color),
      })
      .then((savedStyle) => {
        trayLyricsStyleDraft = { ...savedStyle };
        return savedStyle;
      })
      .finally(() => {
        trayLyricsStyleSaving = false;
      });
  }
</script>

<h1 class="text-2xl font-bold">托盘菜单</h1>
<p class="mt-2 text-gray-700">选择托盘菜单如何响应你的操作。</p>

{#if api.platform === "linux"}
  {#await trayLyricsEnabledPromise then trayLyricsEnabled}
    {@const enabled = trayLyricsEnabled === "true"}
    <Field.Field orientation="horizontal" class="mt-6">
      <Field.Content>
        <Field.Title>状态栏歌词</Field.Title>
        <Field.Description>
          在 GNOME 顶部状态栏中单独显示当前歌词。需要安装并启用 Open Orpheus
          GNOME Shell 扩展。
        </Field.Description>
        {#if extensionInstallPromise}
          {#await extensionInstallPromise}
            <Field.Description>正在安装并启用 GNOME Shell 扩展…</Field.Description>
          {:then result}
            <Field.Description>
              {result.message}
            </Field.Description>
          {:catch error}
            <Field.Description>
              安装 GNOME Shell 扩展失败：{error instanceof Error
                ? error.message
                : String(error)}
            </Field.Description>
          {/await}
        {/if}
      </Field.Content>
      <div class="flex gap-2">
        {#await extensionInfoPromise}
          <Button variant="outline" disabled>检测中</Button>
        {:then extensionInfo}
          {@const needsSessionRestart =
            extensionInfo.installed && extensionInfo.needsSessionRestart}
          {@const needsEnable =
            extensionInfo.installed &&
            extensionInfo.upToDate &&
            extensionInfo.recognized &&
            !extensionInfo.enabled}
          <Button
            variant="outline"
            disabled={!canInstallOrEnableExtension(extensionInfo) ||
              extensionInstalling}
            onclick={installTrayLyricsExtension}
          >
            {getExtensionButtonText(extensionInfo)}
          </Button>
          {#if needsSessionRestart}
            <Field.Description class="self-center">
              已安装新版扩展，重新登录后会加载右键菜单和样式修改。
            </Field.Description>
          {:else if needsEnable}
            <Field.Description class="self-center">
              扩展已安装但未启用，点击“启用扩展”后显示状态栏歌词。
            </Field.Description>
          {/if}
        {:catch}
          <Button variant="outline" onclick={installTrayLyricsExtension}>
            安装并开启
          </Button>
        {/await}
        <Button
          variant={enabled ? "destructive" : "default"}
          onclick={() => setTrayLyricsEnabled(!enabled)}
        >
          {enabled ? "关闭" : "开启"}
        </Button>
      </div>
    </Field.Field>
  {/await}

  {#await trayLyricsStylePromise then trayLyricsStyle}
    <Field.Field orientation="horizontal" class="mt-2">
      <Field.Content>
        <Field.Title>状态栏歌词样式</Field.Title>
        <Field.Description>
          字体留空使用 GNOME Shell 默认字体；显示颜色支持 #RGB、#RRGGBB、RGB
          或 RRGGBB，留空使用当前 Shell 主题颜色。
        </Field.Description>
      </Field.Content>
      <div class="grid w-72 gap-2">
        {#await systemFontsPromise}
          <select
            aria-label="状态栏歌词字体"
            class="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
            disabled
          >
            <option>正在读取字体</option>
          </select>
        {:then systemFonts}
          <select
            aria-label="状态栏歌词字体"
            class="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
            bind:value={trayLyricsStyleDraft.fontFamily}
          >
            <option value="">默认字体</option>
            {#if trayLyricsStyleDraft.fontFamily &&
              !systemFonts.includes(trayLyricsStyleDraft.fontFamily)}
              <option value={trayLyricsStyleDraft.fontFamily}>
                {trayLyricsStyleDraft.fontFamily}
              </option>
            {/if}
            {#each systemFonts as font (font)}
              <option value={font}>{font}</option>
            {/each}
          </select>
        {:catch}
          <Input
            aria-label="状态栏歌词字体"
            placeholder="默认字体"
            bind:value={trayLyricsStyleDraft.fontFamily}
          />
        {/await}
        <div class="flex gap-2">
          <Input
            aria-label="状态栏歌词显示颜色"
            placeholder="#ffffff"
            bind:value={trayLyricsStyleDraft.color}
          />
          <Input
            aria-label="选择状态栏歌词显示颜色"
            type="color"
            class="w-12 px-1"
            value={getColorPickerValue(trayLyricsStyleDraft.color)}
            oninput={(event) => {
              trayLyricsStyleDraft.color = event.currentTarget.value;
            }}
          />
          <Button
            disabled={trayLyricsStyleSaving ||
              (trayLyricsStyleDraft.fontFamily === trayLyricsStyle.fontFamily &&
                normalizeColor(trayLyricsStyleDraft.color) ===
                  trayLyricsStyle.color)}
            onclick={() => setTrayLyricsStyle({ ...trayLyricsStyleDraft })}
          >
            保存
          </Button>
          <Button
            variant="outline"
            disabled={trayLyricsStyleSaving}
            onclick={() => setTrayLyricsStyle({ fontFamily: "", color: "" })}
          >
            重置
          </Button>
        </div>
      </div>
    </Field.Field>
  {/await}

  {#await clickBehaviorPromise then value}
    <RadioGroup.Root
      class="mt-2"
      bind:value={
        () => (value || "depends-on-main-window") as TrayClickBehavior,
        (v) => {
          kv.set("tray.clickBehavior", v);
          clickBehaviorPromise = Promise.resolve(v);
        }
      }
    >
      <Field.Label for="depends-on-main-window">
        <Field.Field orientation="horizontal">
          <Field.Content>
            <Field.Title>取决于主窗口状态</Field.Title>
            <Field.Description>
              当主窗口打开时，点击托盘图标会显示菜单；当主窗口关闭时，点击托盘图标会打开主窗口。
            </Field.Description>
          </Field.Content>
          <RadioGroup.Item
            id="depends-on-main-window"
            value="depends-on-main-window"
          />
        </Field.Field>
      </Field.Label>
      <Field.Label for="always-show-menu">
        <Field.Field orientation="horizontal">
          <Field.Content>
            <Field.Title>总是显示菜单</Field.Title>
            <Field.Description>
              无论主窗口状态如何，点击托盘图标都会显示菜单。此外，在“退出”上添加“显示主窗口”选项。
            </Field.Description>
          </Field.Content>
          <RadioGroup.Item id="always-show-menu" value="always-show-menu" />
        </Field.Field>
      </Field.Label>
      <Field.Label for="with-native-menu">
        <Field.Field orientation="horizontal">
          <Field.Content>
            <Field.Title>使用原生菜单</Field.Title>
            <Field.Description>
              无论主窗口状态如何，点击托盘图标都会显示主窗口。右击托盘图标会显示一个原生菜单，仅包含“显示菜单”选项，用于呼出菜单。
            </Field.Description>
          </Field.Content>
          <RadioGroup.Item id="with-native-menu" value="with-native-menu" />
        </Field.Field>
      </Field.Label>
    </RadioGroup.Root>
  {/await}
{:else}
  <p>此选项仅在 Linux 上可用。</p>
{/if}
