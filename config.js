/*
 * config.js —— 这是你唯一需要修改的文件。
 *
 * 把下面这份「示例旅程」换成你自己的故事：
 *   1. 主角、日期、封面文案（① hero / ② page）
 *   2. 每一天每一站的名字与文字（③ stops）
 *   3. 地图上站点摆放的位置（④ map.positions，可选）
 *   4. 照片：把真实照片放进 assets/photos/ 目录，
 *      然后在 stops 的 gallery 里写相对路径（示例用的是占位图）。
 *
 * 引擎会自动把 封面 / 地图 / 章节 / 终章 / 回忆册 全部按这里的配置渲染出来。
 * 示例内容（主角名、日期、站点等）仅用于演示效果，请放心替换成你自己的。
 */
window.TRIP_CONFIG = {
  /* ================================================================
   * ① 主角与基础信息
   * ============================================================== */
  uid: "my-birthday-trip", // 本地进度存档标识：换一次旅程就改一下，避免串档
  theme: "seaside", // 风格主题：seaside 海边暖沙 / forest 森林 / starry 星光夜

  page: {
    title: "欣的生日旅行", // 浏览器标签页标题
    description: "一封在手机里慢慢展开的旅行邀请。", // 分享到微信/网页时的简介
    ogImage: "assets/map/map-seaside.webp", // 分享卡片配图（可换你的封面图）
  },

  hero: {
    name: "欣", // 寿星 / 主角称呼（会出现在封面、终章）
    badge: "BIRTHDAY TRIP", // 封面上方的英文小字徽章，随你喜欢
    datesLabel: "6.28 → 6.30", // 行程日期（封面与各页会用到）
    titleLines: ["欣，", "生日快乐"], // 封面主标题，可拆两行（可以不要第一行）
    subLines: [
      // 封面副标题，几行都行
      "这几天，我们把城市放一放，",
      "往有风的地方开。手作、烟火和慢慢吃的饭，",
      "都会变成我们新的故事。",
    ],
    coupleName: "我们的旅行", // 封面底部的落款
    coupleNote: "每一天，都值得被记住。", // 落款旁的小字
    coverImage: "assets/ai/ai-bonfire.webp", // 封面大图（推荐深色夜景；留空 "" 用纯色封面）
    avatars: ["assets/avatars/prince.webp", "assets/avatars/princess.webp"], // 可选：两位小人（封面落款 + 地图上沿路线走的主角）
    // 留空 [] 则封面上不显示头像；地图上的小人也会隐藏（不影响体验）
  },

  /* ================================================================
   * ② 一些固定文案（想改就改，不想改就留着）
   * ============================================================== */
  copy: {
    mapEyebrow: "OUR LITTLE TRIP", // 地图页顶部英文小标
    mapTitle: "旅程路线地图", // 地图页标题
    mapChipNote: "每天的路线，会在地图上慢慢点亮", // 封面底部小字
    routeSectionTitle: "这几天的安排", // 地图页「行程表」标题
    memoryLink: "翻开旅程回忆册", // 各处通往回忆册的链接文字
    memoryTitle: "旅程回忆册", // 回忆册标题
    memorySub: [
      "故事已经走完，",
      "照片替我们把风声和星光都留了下来。",
    ],
    memoryTail: [
      "相册会一直在这里。",
      "属于我们的故事，还没有结束。",
    ],
  },

  /* ================================================================
   * ③ 每一站（旅程的核心）
   *    字段说明：
   *      day    —— 第几天（决定 DAY 标签与回忆册分组）
   *      title  —— 站名
   *      short  —— 地图面板 / 章节页的简介一句话
   *      place  —— 可选：这一站在哪（章节页小标签）
   *      story  —— 章节页正文，一行一段
   *      mood   —— 章节页的「心情」卡片一句话
   *      task   —— 可选：这一站想留给 TA 的小任务（照片 / 心愿）
   *      hint   —— 可选：填了就会显示「骰子机会券」小游戏 + 卡片提示
   *      image  —— 章节页大图（放 assets/photos/ 或复用 assets/ai 示例插画）
   *      gallery / galleryCaption —— 这一站的照片墙（回忆册也会按天收录）
   *      videos —— 可选：这一站的视频（结构见最后一站的注释）
   *      icon   —— 地图上站点的小图标（assets/icons/ 里挑）
   *      music  —— 可选：这一站播放的旋律主题（见 app.js 内置主题，不填用封面曲）
   *      action / opensFinale —— 最后一站填 action 文案 + opensFinale: true
   * ============================================================== */
  dayDates: { 1: "6.28", 2: "6.29", 3: "6.30" }, // DAY n 标签上显示的日期（可省）

  stops: [
    {
      id: "workshop",
      day: 1,
      title: "印记工坊",
      short: "第一天下午，先去做一件可以一直戴着的纪念。",
      place: "这一站是：手作工坊里",
      story: [
        "旅程从一间亮着暖光的手作工坊开始。",
        "银条在手里慢慢弯曲、敲平，把名字和这一天轻轻印进去。",
        "往后的日子，低头看见手腕，就会想起今天。",
      ],
      mood: "有些约定不必说出口，戴在手上就够了。",
      task: "把两件作品放在一起，拍一张合照。",
      hint: "第 1 张卡：手作卡，开工前打开。",
      image: "assets/ai/ai-craft.webp",
      gallery: [
        "assets/photos/sample/photo-01.svg",
      ],
      galleryCaption: ["认真做的纪念"],
      icon: "assets/icons/secret-pavilion.webp",
      music: "craft",
      action: "继续旅程",
    },
    {
      id: "cinema",
      day: 1,
      title: "夜场电影院",
      short: "晚上去看一场电影，让第一天慢慢收尾。",
      place: "这一站是：一家电影院里",
      story: [
        "天色暗下来之后，我们钻进电影院。",
        "银幕亮起来的那一刻，你靠过来的肩膀，比剧情更让人记得。",
        "第一天的结尾，是一起看完的两个小时。",
      ],
      mood: "好故事值得慢慢讲完，好日子也是。",
      task: "收好票根，或者拍一张检票口的照片。",
      hint: "第 2 张卡：电影卡，开场前打开。",
      image: "assets/ai/ai-cinema.webp",
      gallery: [],
      galleryCaption: [],
      icon: "emoji:🎬", // 图标支持：预设图标 / emoji（如 🎬）/ 上传贴纸
      music: "cinema",
      action: "继续旅程",
    },
    {
      id: "seaside",
      day: 2,
      title: "启程，去海边",
      short: "第二天一早，开车往有海风的方向走。",
      place: "这一站是：去往海边的路上",
      story: [
        "第二天，我们把城市留在身后，一路往前开。",
        "车越开，空气里的咸味越明显；当海平线出现在挡风玻璃外，我们知道快到了。",
        "好日子值得慢慢抵达。",
      ],
      mood: "最好的风景，都在慢慢靠近的路上。",
      task: "拍一张沿途的风景，或者只拍一路变蓝的天。",
      hint: "第 3 张卡：出发卡，上车前打开。",
      image: "assets/ai/ai-depart.webp",
      gallery: ["assets/photos/sample/photo-02.svg"],
      galleryCaption: ["一路变蓝的天"],
      icon: "assets/icons/depart.webp",
      music: "depart",
      action: "继续旅程",
    },
    {
      id: "beach",
      day: 2,
      title: "海边的下午",
      short: "下午把时间留给沙滩和浪声。",
      place: "这一站是：离海最近的地方",
      story: [
        "下午我们哪儿也不去，就待在离海最近的地方。",
        "风把时间吹慢，浪一下一下地来，像替我们把想说的话都说完了。",
        "旅行可以慢慢走，这样待在一起的感觉，我想一直留着。",
      ],
      mood: "最好的度假，是哪里都不用赶。",
      task: "拍一张只属于今天的海边角落。",
      hint: "第 4 张卡：海边卡，下水前打开。",
      image: "assets/ai/ai-resort.webp",
      gallery: [
        "assets/photos/sample/photo-03.svg",
        "assets/photos/sample/photo-04.svg",
      ],
      galleryCaption: ["慢慢走的下午", "只属于今天的海边"],
      /* 想放视频就按下面这样写（把 mp4 放进 assets/photos/）：
      videos: [
        {
          src: "assets/photos/sea.mp4",
          poster: "assets/photos/sea-cover.jpg",
          caption: "海浪的声音",
        },
      ],
      */
      icon: "assets/icons/memory-album.webp",
      music: "resort",
      action: "继续旅程",
    },
    {
      id: "bonfire",
      day: 2,
      title: "篝火与烟花",
      short: "入夜后，沙滩上点起篝火，烟花也升起来。",
      place: "这一站是：海边沙滩",
      story: [
        "入夜之后，篝火把夜色烤暖，远处的烟花一个接一个升空。",
        "火光把脸照得暖洋洋的，我们谁也没说话，只是看着。",
        "如果今晚的烟花有名字，它大概就叫「今天」。",
      ],
      mood: "如果烟花正好照亮你的脸，那今天就是对的。",
      task: "烟花亮起来的时候，一起许一个愿。",
      hint: "第 5 张卡：篝火卡，点燃前打开。",
      image: "assets/ai/ai-bonfire.webp",
      gallery: ["assets/photos/sample/photo-05.svg"],
      galleryCaption: ["烟花亮起来的晚上"],
      icon: "assets/icons/dinner-house.webp",
      music: "bonfire",
      action: "继续旅程",
    },
    {
      id: "last-dinner",
      day: 3,
      title: "收尾的这一餐",
      short: "第三天晚上，用一顿慢慢吃的饭，把旅行收尾。",
      place: "这一站是：一家安静的日料店",
      story: [
        "最后一晚，我们坐下来，把这次旅行慢慢收尾。",
        "料理一道一道端上来，像这几天的心意被一道一道讲完。",
        "最好的告别，是下次再见。",
      ],
      mood: "最重要的话，不需要大声，只要刚好被听见。",
      task: "给这次旅行挑一张最喜欢的照片。",
      hint: "第 6 张卡：惊喜卡，开动前打开。",
      image: "assets/ai/ai-omakase.webp",
      gallery: [],
      galleryCaption: [],
      icon: "assets/icons/gift-castle.webp",
      music: "omakase",
      action: "打开最后的惊喜",
      opensFinale: true, // 只有最后一站填 true
    },
  ],

  /* ================================================================
   * ④ 地图（可选配置）
   *    positions：每个站一个点 {x, y}，取值 0-100，是地图上的百分比位置。
   *    没有配置背景图时，地图会自动按纵向排列站点；配置了背景图后，
   *    建议手动摆放点位让它们落在背景的风景上。
   *    不写 positions 也没关系，引擎会自动排布。
   * ============================================================== */
  map: {
    background: "assets/map/map-seaside.webp", // 留空 "" 则用纯色底 + 自动排列
    markerStyle: "pin", // 地图标记样式：pin 图钉 / card 卡片
    positions: [
      { x: 8, y: 84 },
      { x: 30, y: 70 },
      { x: 55, y: 84 },
      { x: 80, y: 58 },
      { x: 58, y: 28 },
      { x: 26, y: 20 },
    ],
  },
};
