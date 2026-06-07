<script lang="ts">
  import * as RadioGroup from "$lib/components/ui/radio-group";
  import * as Field from "$lib/components/ui/field";
  import * as settings from "$lib/settings";

  type TrayClickBehavior =
    | "depends-on-main-window"
    | "always-show-menu"
    | "always-show-main-window";

  let clickBehaviorPromise = $state(settings.get("tray.clickBehavior"));
</script>

<h1 class="text-2xl font-bold">托盘图标</h1>
<p class="mt-2 text-gray-700">选择托盘图标如何响应你的左键点击（激活）。</p>

{#await clickBehaviorPromise then value}
  <RadioGroup.Root
    class="mt-2"
    bind:value={
      () => (value || "depends-on-main-window") as TrayClickBehavior,
      (v) => {
        settings.set("tray.clickBehavior", v);
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
    <Field.Label for="always-show-main-window">
      <Field.Field orientation="horizontal">
        <Field.Content>
          <Field.Title>总是打开主窗口</Field.Title>
          <Field.Description>
            无论主窗口状态如何，点击托盘图标都会打开主窗口。
          </Field.Description>
        </Field.Content>
        <RadioGroup.Item
          id="always-show-main-window"
          value="always-show-main-window"
        />
      </Field.Field>
    </Field.Label>
  </RadioGroup.Root>
{/await}
