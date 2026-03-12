// Script for early-state development of the UI module.

import { App, Menu } from "@open-orpheus/ui";

import { readPack, readFile } from "./src/main/ntpk.ts";

setInterval(() => {
  // keep alive
}, 1000);

async function main() {
  await readPack();

  const menuData = MENU_DATA;
  menuData.content = JSON.parse(menuData.content);
  menuData.hotkey = JSON.parse(menuData.hotkey);

  for (const item of menuData.content) {
    if (item.image_path) {
      const url = new URL(item.image_path);
      item.image_path = null;
      if (url.protocol === "orpheus:" && url.hostname === "orpheus") {
        const path = url.pathname;
        try {
          const buf = await readFile(path);
          if (path.endsWith(".svg")) {
            item.image_path = `base64://svg${buf.toString("base64")}`;
          } else {
            item.image_path = `base64://raw${buf.toString("base64")}`;
          }
        } catch {
          /* empty */
        }
      }
    }
  }

  const app = new App();

  const menu = new Menu(app, menuData);
}

main();

const MENU_DATA = {"content":"[{\"text\":\"播放\",\"menu\":true,\"enable\":true,\"separator\":false,\"children\":null,\"image_color\":\"#ff7e6f68\",\"hotkey\":\"Enter\",\"image_path\":\"orpheus://orpheus/pub/public/assets/svg/menu/play.svg\",\"menu_id\":\"play\"},{\"text\":\"下一首播放\",\"menu\":true,\"enable\":true,\"separator\":false,\"children\":null,\"image_color\":\"#ff7e6f68\",\"image_path\":\"orpheus://orpheus/pub/public/assets/svg/menu/next.svg\",\"menu_id\":\"nextPlay\"},{\"text\":\"查看评论(3379)\",\"menu\":true,\"enable\":true,\"separator\":false,\"children\":null,\"image_color\":\"#ff7e6f68\",\"image_path\":\"orpheus://orpheus/pub/public/assets/svg/menu/comment.svg\",\"menu_id\":\"{\\\"actionId\\\":\\\"link\\\",\\\"menuPayload\\\":{\\\"actionData\\\":{\\\"to\\\":{\\\"scene\\\":\\\"comment\\\",\\\"state\\\":{\\\"resourceType\\\":\\\"track\\\",\\\"resource\\\":{\\\"id\\\":\\\"573548637\\\",\\\"alias\\\":[],\\\"commentThreadId\\\":\\\"R_SO_4_573548637\\\",\\\"copyrightId\\\":\\\"0\\\",\\\"duration\\\":214726,\\\"mvid\\\":\\\"\\\",\\\"name\\\":\\\"七劫謡（七劫谣）\\\",\\\"cd\\\":\\\"01\\\",\\\"position\\\":1,\\\"ringtone\\\":null,\\\"rtUrl\\\":null,\\\"status\\\":0,\\\"pstatus\\\":0,\\\"fee\\\":0,\\\"version\\\":53,\\\"songType\\\":0,\\\"mst\\\":9,\\\"popularity\\\":85,\\\"ftype\\\":0,\\\"rtUrls\\\":[],\\\"transNames\\\":[\\\"七劫谣\\\"],\\\"noCopyrightRcmd\\\":null,\\\"originCoverType\\\":0,\\\"mark\\\":262208,\\\"artists\\\":[{\\\"accountId\\\":\\\"\\\",\\\"id\\\":\\\"9026\\\",\\\"albumSize\\\":0,\\\"alia\\\":[],\\\"alias\\\":[],\\\"fansGroup\\\":null,\\\"img1v1Url\\\":\\\"\\\",\\\"name\\\":\\\"冥月\\\",\\\"picId\\\":\\\"\\\",\\\"trans\\\":\\\"\\\",\\\"transName\\\":\\\"\\\",\\\"fansSize\\\":0,\\\"musicSize\\\":0,\\\"algorithm\\\":\\\"\\\",\\\"override\\\":{\\\"title\\\":\\\"\\\",\\\"subTitle\\\":\\\"\\\",\\\"imageUrl\\\":\\\"\\\"}}],\\\"algorithm\\\":\\\"\\\",\\\"songTag\\\":{},\\\"album\\\":{\\\"id\\\":\\\"39689382\\\",\\\"name\\\":\\\"七劫謡\\\",\\\"description\\\":\\\"\\\",\\\"trackCount\\\":0,\\\"subscribedCount\\\":0,\\\"commentCount\\\":0,\\\"commentThreadId\\\":\\\"R_AL_3_39689382\\\",\\\"algorithm\\\":\\\"\\\",\\\"size\\\":0,\\\"override\\\":{\\\"title\\\":\\\"\\\",\\\"subTitle\\\":\\\"\\\",\\\"imageUrl\\\":\\\"\\\"},\\\"albumName\\\":\\\"七劫謡\\\",\\\"picId\\\":\\\"109951163354772750\\\",\\\"picUrl\\\":\\\"http://p3.music.126.net/A1wjX4yKNeyQy5fRjTBsNg==/109951163354772750.jpg\\\",\\\"cover\\\":\\\"http://p3.music.126.net/A1wjX4yKNeyQy5fRjTBsNg==/109951163354772750.jpg\\\",\\\"alias\\\":[],\\\"transNames\\\":[],\\\"explicit\\\":false},\\\"explicit\\\":false,\\\"privilege\\\":{\\\"id\\\":\\\"573548637\\\",\\\"fee\\\":0,\\\"payed\\\":0,\\\"maxPlayBr\\\":320000,\\\"maxDownBr\\\":320000,\\\"maxPlayBd\\\":null,\\\"commentPriv\\\":1,\\\"cloudSong\\\":0,\\\"toast\\\":false,\\\"flag\\\":3440898,\\\"now\\\":1773289729000,\\\"maxSongBr\\\":320,\\\"maxFreeBr\\\":320,\\\"sharePriv\\\":7,\\\"status\\\":0,\\\"subPriv\\\":1,\\\"maxSongLevel\\\":6999,\\\"maxDownLevel\\\":320000,\\\"maxFreeLevel\\\":320,\\\"maxPlayLevel\\\":320000,\\\"freeTrialPrivilege\\\":{\\\"resConsumable\\\":false,\\\"userConsumable\\\":false,\\\"listenType\\\":null,\\\"cannotListenReason\\\":null,\\\"playReason\\\":null,\\\"freeLimitTagType\\\":null}}}}}}}}\"},{\"text\":\"菜单项\",\"menu\":true,\"enable\":true,\"separator\":true,\"children\":null,\"image_color\":\"#ff7e6f68\",\"menu_id\":null},{\"text\":\"收藏\",\"menu\":true,\"enable\":true,\"separator\":false,\"children\":null,\"image_color\":\"#ff7e6f68\",\"hotkey\":\"Ctrl S\",\"image_path\":\"orpheus://orpheus/pub/public/assets/svg/menu/collect.svg\",\"menu_id\":\"favorite\"},{\"text\":\"下载\",\"menu\":true,\"enable\":true,\"separator\":false,\"children\":null,\"image_color\":\"#ff7e6f68\",\"image_path\":\"orpheus://orpheus/pub/public/assets/svg/menu/download.svg\",\"menu_id\":\"download\"},{\"text\":\"分享\",\"menu\":true,\"enable\":true,\"separator\":false,\"children\":null,\"image_color\":\"#ff7e6f68\",\"image_path\":\"orpheus://orpheus/pub/public/assets/svg/menu/share.svg\",\"menu_id\":\"share\"},{\"text\":\"复制链接\",\"menu\":true,\"enable\":true,\"separator\":false,\"children\":null,\"image_color\":\"#ff7e6f68\",\"image_path\":\"orpheus://orpheus/pub/public/assets/svg/menu/copy.svg\",\"menu_id\":\"copy\"},{\"text\":\"菜单项\",\"menu\":true,\"enable\":true,\"separator\":true,\"children\":null,\"image_color\":\"#ff7e6f68\",\"menu_id\":null},{\"text\":\"从歌单中删除\",\"menu\":true,\"enable\":true,\"separator\":false,\"children\":null,\"image_color\":\"#ff7e6f68\",\"image_path\":\"orpheus://orpheus/pub/public/assets/svg/menu/delete.svg\",\"hotkey\":\"Delete\",\"menu_id\":\"remove\"}]","hotkey":"{\"play\":\"Enter\",\"favorite\":\"Ctrl S\",\"remove\":\"Delete\"}","left_border_size":0,"menu_type":"normal"};
