# 公卫中级 · 疾病控制（361）每日复习站

把 24 篇复习文章做成的静态网站，包含：

- 系列首页（24 篇卡片，按章/部分排列）
- 每篇独立页面：黄色高亮 = 原笔记标黄重点；红/蓝/灰徽章 = 掌握/熟悉/了解
- 网页朗读：底部毛玻璃播放器（苹果音乐风格）「▶」大圆钮播放/暂停，支持上一句/下一句、0.75~2 倍速、逐句高亮跟读、动态均衡器动画
- 知识点分行：①②③… 与 ⑴⑵⑶… 编号点自动逐条换行，便于逐条记忆
- 阅读进度：自动记录每篇阅读百分比，读完 85% 自动标记「已完成」，首页卡片显示状态（保存在本机浏览器）
- 键盘快捷键：空格 = 播放/暂停；←/→ = 上一篇/下一篇
- 兼容系统朗读：苹果「朗读屏幕」、Edge「大声朗读」均可直接使用

> 关于苹果朗读：网页“▶”按钮在 iPhone 上调用的就是 iOS 自带中文语音（与系统朗读同引擎）。
> 想用系统“朗读屏幕”（可后台播放）：设置 → 辅助功能 → 朗读内容 → 开启“朗读屏幕”，
> 打开文章后双指从屏幕顶部下滑即可。每篇文章底部播放器里有「🍎 系统朗读」说明按钮。

## 本地预览

直接双击 `index.html` 即可在浏览器中打开使用（无需联网）。

## 发布到 GitHub Pages（免费）

### 方法一：网页直接上传（最简单，无需装软件）

1. 注册/登录 GitHub：https://github.com
2. 点右上角 `+` → New repository → 名称填 `wx361-review` → 选 Public → Create repository
3. 在新仓库页面点 `uploading an existing file`（或 Add file → Upload files）
4. 把本文件夹（`index.html`、`articles/`、`css/`、`js/`、`assets/`）里的文件全部拖进去（可一次多选）
5. 页面底部 Commit changes → Commit
6. 仓库 Settings → Pages → Source 选 `Deploy from a branch` → Branch 选 `main` + `/ (root)` → Save
7. 等 1~3 分钟，访问：`https://你的用户名.github.io/wx361-review/`

### 方法二：GitHub Desktop（推荐给不熟命令行的用户）

1. 下载安装 GitHub Desktop：https://desktop.github.com ，登录账号
2. File → New repository…（名称 `wx361-review`，Public）→ Create repository
3. 把本文件夹内容复制进仓库目录，GitHub Desktop 会显示变更 → Commit to main → Publish repository
4. 按方法一第 6~7 步开启 Pages

### 方法三：命令行 git

```bash
cd 网站版
git init
git add .
git commit -m "init: 24 篇复习文章网站"
git branch -M main
git remote add origin https://github.com/你的用户名/wx361-review.git
git push -u origin main
```

首次推送需要登录：用浏览器弹出窗口登录，或在 push 时用「Personal access token」代替密码（GitHub → Settings → Developer settings → Personal access tokens → Generate new token，勾选 repo 权限）。

## 更新内容

- 文章内容来自 `C:\Users\CCC\Downloads\中级\公众号系列`，改完后运行
  `_work\gen_site.py` 重新生成网站，再 `git add . && git commit && git push`。
- 朗读脚本在 `js/app.js`，样式在 `css/style.css`。

## 说明

- 阅读进度存在浏览器 localStorage，换设备/清缓存会重置。
- GitHub Pages 免费版要求仓库 Public；想用 Private 需升级 Pro。
- 国内网络访问 `*.github.io` 可能不稳定，可另选 Gitee Pages、Cloudflare Pages 或 Netlify（同样免费，部署步骤类似）。
