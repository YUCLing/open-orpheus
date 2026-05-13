<script lang="ts">
  import * as RadioGroup from "$lib/components/ui/radio-group";
  import * as Field from "$lib/components/ui/field";
  import { getBridge } from "$lib/bridge";
  import type { ManageContract } from "$bridge/contracts/manage-api";

  const api = getBridge<ManageContract>("manage");

  type TrayClickBehavior =
    | "depends-on-main-window"
    | "always-show-menu"
    | "with-native-menu"
    | "with-native-menu-gnome";

  let clickBehaviorPromise = $state(kv.get("tray.clickBehavior"));
</script>

<h1 class="text-2xl font-bold">托盘菜单</h1>
<p class="mt-2 text-gray-700">选择托盘菜单如何响应你的操作。</p>

{#if api.platform === "linux"}
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
              无论主窗口状态如何，点击托盘图标都会显示菜单。此外，在"退出"上添加"显示主窗口"选项。
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
              无论主窗口状态如何，点击托盘图标都会显示主窗口。右击托盘图标会显示一个原生菜单，仅包含"显示菜单"选项，用于呼出菜单。
            </Field.Description>
          </Field.Content>
          <RadioGroup.Item id="with-native-menu" value="with-native-menu" />
        </Field.Field>
      </Field.Label>
      <Field.Label for="with-native-menu-gnome">
        <Field.Field orientation="horizontal">
          <Field.Content>
            <Field.Title>使用原生菜单 Gnome兼容</Field.Title>
            <Field.Description>
              适用于 GNOME 桌面环境。点击托盘图标会显示完整的原生菜单，包含播放控制、歌词、设置等选项。需要重启应用程序。
            </Field.Description>
          </Field.Content>
          <RadioGroup.Item id="with-native-menu-gnome" value="with-native-menu-gnome" />
        </Field.Field>
      </Field.Label>
    </RadioGroup.Root>
  {/await}
{:else}
  <p>此选项仅在 Linux 上可用。</p>
{/if}
