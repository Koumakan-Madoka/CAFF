---
feature_ids: [F005]
related_features: [F002, F003, F004]
topics: [chat, image, multimodal, content-blocks, capability, routing, upload, storage, provider]
doc_kind: spec
created: 2026-08-09
---

# F005: Image Input and Multimodal Message Routing

> **Status**: spec | **Owner**: @cat-ir4rwo6b (kickoff lead @opus/opus) | **Priority**: P1

## Why

CAFF 鑱婂ぉ鐩墠鍙敮鎸佺函鏂囨湰娑堟伅锛歚chat_messages.content` 鏄崟涓€ TEXT锛屽彂閫佹帴鍙ｅ彧鎺ユ敹 `{ content, clientRequestId }`锛屾病鏈変换浣曞浘鐗囪緭鍏ャ€佸唴瀹瑰潡鎴栧妯℃€佽兘鍔涘垽瀹氱殑濂戠害銆侰AFF 鍘熷鏀归€犳効鏅紙`thread_msiputnz4yxhs6j3`锛夋槑纭姹?鏀寔鍥剧墖杈撳叆"锛屼笖澶氭ā鎬佽矾鐢变笉鑳介潬纭紪鐮佹ā鍨嬪悕鐚溾€斺€斿繀椤诲湪 capability registry 灞傚洖绛?杩欎釜妯″瀷鑳戒笉鑳借鍥?锛屽啀鍐冲畾鎶婂浘鐗囬€佺粰璋併€?
浠峰€肩粓鐐癸細operator 鍦ㄨ亰澶╅噷閫変竴寮犲浘銆侀瑙堛€侀殢鏂囨湰鍙戝嚭锛屽甫鍥炬秷鎭湪鍒锋柊/鍘嗗彶鍥炴斁/缁х画浼氳瘽鍚庝緷鐒跺畬鏁达紱璺敱灞備緷鎹?CAFF 鑷繁鐨?capability registry 鍒ゆ柇鐩爣妯″瀷鏄惁鏀寔鍥剧墖杈撳叆锛屾敮鎸佺殑 provider adapter 鏀跺埌缁撴瀯鍖?image 鍐呭锛屼笉鏀寔鐨勬ā鍨嬪湪鍙戦€佸墠鎴栬矾鐢卞琚槑纭樆鏂€斺€斾换浣曡矾寰勯兘涓嶅緱闈欓粯涓㈠浘銆?
## Current State / 鐜扮姸鍩虹嚎

Baseline: `origin/main@3c51a8b` (2026-08-08)銆?
- `chat_messages` 琛ㄥ彧鏈?`content TEXT NOT NULL`锛宍metadata_json TEXT` 宸叉壙杞?F003 鐨?`clientRequestId`銆佷笂涓嬫枃蹇収绛夋墿灞曪紝浣?*娌℃湁 content-block 鎴栧浘鐗囧绾?*锛坄storage/sqlite/migrations.ts:284-300`锛沗storage/chat/message.repository.ts` 鍏ㄩ儴鎸?string 璇诲啓锛夈€?- 鍓嶇 composer 鍙彂 `{ content, clientRequestId }` 鍒?`POST /api/conversations/:id/messages`锛坄public/app.js:4375-4378`锛沗server/api/conversations-controller.ts:1017-1020`锛夛紱杈撳叆鍖哄彧鏈?textarea锛坄public/index.html:96-113`锛夛紝鏃?file input/棰勮/鎷栨嫿銆?- 娑堟伅鎶曞奖锛歚turn-orchestrator` 鈫?`routing-executor` 鎶婃秷鎭粍瑁呮垚 `promptMessages`锛坄prompt-visibility.ts`锛夛紝`agent-executor.ts:1239-1240` 鍐?`buildAgentTurnPromptSections`/`formatAgentTurnPromptSections` 鎷兼垚**绾瓧绗︿覆 prompt**锛岀粡 `startRun(provider, model, prompt, ...)`锛坄agent-executor.ts:1456`锛夎繘鍏?`pi-sdk-host.mjs` 鐨?`session.prompt(prompt)`锛坄pi-sdk-host.mjs:225`锛夈€傛暣鏉￠摼鐩墠鍙秷璐瑰瓧绗︿覆銆?- PI runtime 宸茶兘瑙ｆ瀽 assistant 渚х殑 content-block 鏁扮粍锛坄lib/pi-runtime.ts:174-205` 鐨?`extractAssistantText` / `assistantMessageHasPendingToolUse`锛夛紝璇存槑 SDK 浜嬩欢娴佹槸缁撴瀯鍖栫殑锛屼絾 **user prompt 杈撳叆浠嶆槸鍗曞瓧绗︿覆**锛屾棤 image 鍏ュ彛銆?- models domain锛團004锛夛細`model-provider-config.ts` 鐨勮繍琛屾椂濂戠害鍙湁 `id/name/api/baseUrl/family/reasoning`锛?*鏃?modalities/vision/capability 瀛楁**锛泇endored `assets/model-catalog.json` 閲屾湁 `modalities: { input: [...], output: [...] }`锛屼絾鎸?F004 鏄庣‘灞炰簬 catalog metadata锛?*涓嶅緱闈欓粯鍗囩骇涓?runtime 鑳藉姏**銆?- 鏃?`/uploads/` 闈欐€佹湇鍔°€佹棤 multipart 瑙ｆ瀽銆佹棤鍥剧墖涓婁紶鏍￠獙銆佹棤鍥剧墖瀛樺偍锛堜粨搴撻噷浠呭ご鍍?data URL 鏍￠獙鍏堜緥锛歚lib/chat-app-store.ts:222` 闄愬埗 png/jpeg/webp/gif锛夈€?
## What

### Phase A: 缁熶竴 content-block 濂戠害 + 鍙楁帶鍥剧墖涓婁紶瀛樺偍

- 瀹氫箟鏈€灏?content-block 濂戠害锛氭秷鎭湪鐜版湁 `content` 绾枃鏈箣涓婏紝缁?`metadata_json.contentBlocks` 鎼哄甫鍙€夌粨鏋勫寲鍧楋紝棣栫増鍙惈 `{ type: 'text', text }` 涓?`{ type: 'image', url, alt? }`锛坲rl 鎸囧悜鍙楁帶 upload store锛夈€俙content` 淇濇寔鍏煎锛屽巻鍙叉秷鎭€丗TS 鎼滅储銆佹憳瑕?digest 涓嶇牬鍧忋€?- 鏂板鍙楁帶鍥剧墖涓婁紶绔偣锛歁IME 鐧藉悕鍗曪紙png/jpeg/webp/gif锛夈€佸崟鏂囦欢澶у皬涓婇檺銆佹瘡娆″紶鏁颁笂闄愩€佹枃浠跺悕娑堟瘨闃茶矾寰勭┛瓒娿€佹棤绗﹀彿璺緞瑙ｆ瀽锛涘浘鐗囧瓨鍒?upload 鐩綍骞堕€氳繃闈欐€佽矾鐢辨毚闇层€?- 鍥剧墖鎸佷箙鍖栭殢娑堟伅鍘熷瓙鎬э細涓婁紶鏂囦欢涓庢秷鎭惤搴撻€氳繃骞傜瓑娴佺▼鍏宠仈锛屽埛鏂?鍘嗗彶鍥炴斁/缁х画浼氳瘽鍚庡浘鐗囦粛瀛樺湪锛涘鍎夸笂浼犳枃浠朵笉闃诲娑堟伅鍐欏叆銆?- 澶辫触璺緞鏄庣‘锛氫笂浼犳牎楠屽け璐ャ€佸瓨鍌ㄥけ璐ャ€佸浘鐗?URL 鏃犳硶瑙ｆ瀽鏃惰繑鍥炵粨鏋勫寲閿欒锛屽墠绔睍绀轰汉璇濆師鍥狅紝涓嶉潤榛樹涪鍥俱€?
### Phase B: Capability registry 涓庡妯℃€佽矾鐢卞垽瀹?
- 鍦?models domain 鎵╁睍鑳藉姏鍒ゅ畾锛氫粠 catalog `modalities.input` 鏄惧紡鎶曞奖鍑?`supportsImageInput`锛坴ision锛夎兘鍔涗綅锛岀粡 operator 纭鍚庤惤鍏?provider 杩愯鏃跺绾︼紙`models.json`锛夛紝鏈煡/缂哄け涓€寰?fail closed 涓轰笉鏀寔銆?- 璺敱灞傚湪缁勮 user 娑堟伅鏃舵娴?contentBlocks 鏄惁鍚?image锛氱洰鏍?Agent 鐨勬ā鍨嬩笉鏀寔鍥剧墖杈撳叆 鈫?鍦ㄥ彂閫佸墠杩斿洖缁撴瀯鍖栭樆鏂紙鏄庣‘"妯″瀷涓嶆敮鎸佸浘鐗囪緭鍏?锛夛紝涓嶈繘鍏?runtime锛屼笉闈欓粯鍓ュ浘銆?- provider adapter锛圥I SDK host 渚э級锛氭妸缁撴瀯鍖?image block 缈昏瘧鎴?PI 鍙秷璐圭殑杈撳叆鈥斺€斿叿浣撳舰鎬侀渶鍦?Design Gate 鍚?spike 楠岃瘉锛坧rompt hint 璺緞 vs SDK media 鍙傛暟锛岃 Open Questions锛夈€?
### Phase C: 鑱婂ぉ UI 杈撳叆涓庡睍绀?
- composer 澧炲姞鍥剧墖閫夋嫨鍏ュ彛锛氭枃浠堕€夋嫨 + 棰勮 + 绉婚櫎锛岄殢鏂囨湰涓€璧峰彂閫侊紱涓嶆敮鎸佺殑鍥剧墖绫诲瀷/瓒呴檺鍦?UI 灞傚嵆鏃舵彁绀恒€?- 娑堟伅鏃堕棿绾挎覆鏌?image block锛氬巻鍙叉秷鎭洖鏀俱€丼SE 澧為噺銆乺efresh 鍚庡潎鏄剧ず鍥剧墖锛涘睍绀哄け璐ユ湁闄嶇骇鎻愮ず鑰岄潪绌虹櫧銆?
## User Journey

### Primary Journey: 鍙戦€佷竴寮犲浘鐗囧苟璁╁妯℃€佹ā鍨嬬悊瑙?
- **Scope unit**: 涓€娆″甫鍥剧墖鐨勮亰澶╂秷鎭彂閫併€?- **Actor**: operator銆?- **Entry**: 鍦ㄥ綋鍓嶈亰澶╁鐨?composer 涓偣鍑诲浘鐗囧叆鍙ｅ苟閫夋嫨涓€寮犳湰鍦板浘鐗囥€?- **Flow**:
  1. 鍥剧墖鍦ㄨ緭鍏ュ尯鍗虫椂棰勮锛宱perator 鍙Щ闄ゅ悗閲嶆柊閫夋嫨锛屽苟杈撳叆闅忓浘鏂囧瓧銆?  2. 鍙戦€佸悗锛屽甫鍥炬秷鎭珛鍗充互 optimistic 褰㈡€佸嚭鐜板湪鏃堕棿绾匡紙鍚浘鐗囩缉鐣ュ浘锛夈€?  3. 鐩爣 Agent 鐨勬ā鍨嬫敮鎸佸浘鐗囪緭鍏ユ椂锛屽浘鐗囬殢娑堟伅杩涘叆妯″瀷涓婁笅鏂囷紝Agent 鍙弿杩?鍒嗘瀽鍥剧墖鍐呭銆?  4. 鐩爣妯″瀷涓嶆敮鎸佸浘鐗囪緭鍏ユ椂锛屾秷鎭鏄庣‘闃绘柇鎴栧浘鐗囪鏍囨敞涓嶅彲杈撅紝operator 鐪嬪埌浜鸿瘽鍘熷洜锛岀粷涓嶉潤榛樹涪鍥俱€?  5. 鍒锋柊椤甸潰鎴栧洖鍒拌浼氳瘽缁х画鑱婂ぉ锛屽浘鐗囦粛鍦ㄥ師娑堟伅浣嶇疆瀹屾暣鏄剧ず銆?- **Success evidence**: 涓婁紶/瀛樺偍/娓叉煋/鑳藉姏鍒ゅ畾/runtime 浼犺緭鍚勫眰娴嬭瘯 + desktop/375px 娴忚鍣ㄨ瘉鎹€?
### Supporting Journey: 澶氭ā鎬佽兘鍔涗竴鐩簡鐒?
- **Scope unit**: provider 閰嶇疆椤点€?- **Actor**: operator銆?- **Flow**: operator 鍦?provider 閰嶇疆涓兘鐪嬪埌鎵€閫夋ā鍨嬫槸鍚︽敮鎸佸浘鐗囪緭鍏ワ紙鏉ヨ嚜 catalog 鎶曞奖 + 鏄惧紡纭锛夛紝涓嶆敮鎸佺殑妯″瀷涓嶈灞曠ず涓哄彲璇诲浘鑳藉姏銆?- **Evidence**: provider-editor 鎴浘 + capability 鍒ゅ畾娴嬭瘯銆?
## 闇€姹傜偣 Checklist

| ID | 闇€姹傜偣锛坥perator 杞堪/鎰挎櫙锛?| AC | 楠岃瘉鏂瑰紡 |
|----|---------------------------|----|---------|
| R1 | 鑱婂ぉ杈撳叆鍖鸿兘閫夊浘銆侀瑙堛€佺Щ闄ゅ苟闅忔枃鏈彂閫?| AC-C1 | UI 娴嬭瘯 + browser 璇佹嵁 |
| R2 | 鍥剧墖闅忔秷鎭寔涔呭寲锛屽埛鏂?鍥炴斁/缁細璇濅粛瀛樺湪 | AC-A2, AC-A3 | storage/restart 娴嬭瘯 + 鎴浘 |
| R3 | 璺敱鎸?capability 鍒ゅ畾鐩爣妯″瀷鏄惁鏀寔鍥剧墖 | AC-B1, AC-B2 | capability/璺敱娴嬭瘯 |
| R4 | 涓嶆敮鎸佺殑妯″瀷蹇呴』鏄庣‘闃绘柇锛屼笉寰楅潤榛樹涪鍥?| AC-B3 | 闃绘柇璺緞娴嬭瘯 |
| R5 | 涓婁紶瀹夊叏鍙楁帶锛圡IME/澶у皬/寮犳暟/璺緞绌胯秺/SSRF锛?| AC-A1 | 瀹夊叏鏍￠獙娴嬭瘯 |

### 瑕嗙洊妫€鏌?
- [x] 姣忎釜闇€姹傜偣閮借兘鏄犲皠鍒拌嚦灏戜竴鏉?AC
- [x] 姣忎釜 AC 閮芥湁楠岃瘉鏂瑰紡
- [x] 鍓嶇闇€姹傚凡鍑嗗闇€姹傗啋璇佹嵁鏄犲皠琛紙Design Gate锛?
## Acceptance Criteria

### Phase A: Content-block 濂戠害 + 涓婁紶瀛樺偍

- [x] AC-A1: 鍥剧墖涓婁紶绔偣鎷掔粷鐧藉悕鍗曞 MIME銆佽秴闄愭枃浠躲€佽秴寮犳暟銆佽矾寰勭┛瓒婃枃浠跺悕锛沗/uploads/` 鍙湇鍔″彈鎺х洰褰曪紝鏃犵鍙疯矾寰?杩滅▼鎶撳彇锛圫SRF 闈负闆讹級銆傞獙璇侊細鏍￠獙鐭╅樀娴嬭瘯 + 闈欐€佽矾鐢辨祴璇曘€?- [x] AC-A2: 甯﹀浘娑堟伅浠?`contentBlocks`锛坱ext + image url锛夋寔涔呭寲锛宍content` 鏂囨湰鍏煎涓嶅彈鐮村潖锛汧TS 鎼滅储銆佹憳瑕?digest銆佸巻鍙叉秷鎭В鏋愪笉鍥炲綊銆傞獙璇侊細message repository + 鎼滅储/鎽樿娴嬭瘯銆?- [x] AC-A3: 鍒锋柊椤甸潰涓庤繘绋嬮噸鍚悗锛屽浘鐗囧紩鐢ㄤ粛鍙粠闈欐€佽矾鐢辫闂笖娑堟伅鍙畬鏁村洖鏀俱€傞獙璇侊細restart fixture + 娴忚鍣ㄥ洖鏀捐瘉鎹€?- [x] AC-A4: 涓婁紶/瀛樺偍/寮曠敤澶辫触鏃惰繑鍥炵粨鏋勫寲閿欒骞跺睍绀轰汉璇濆師鍥狅紝娑堟伅鍐欏叆涓庡浘鐗囦笂浼犻€氳繃骞傜瓑娴佺▼鍏宠仈锛屼笉浜х敓鍗婁釜娑堟伅鎴栧鍎块樆鏂€傞獙璇侊細閿欒璺緞娴嬭瘯銆?
### Phase B: Capability registry + 璺敱

- [x] AC-B1: capability 鍒ゅ畾浠?catalog `modalities.input` 鏄惧紡鎶曞奖骞剁粡 operator 纭钀藉簱锛宍models.json` 鐢熸晥閰嶇疆浼樺厛锛屾湭鐭ユā鍨?fail closed 涓轰笉鏀寔鍥剧墖銆傞獙璇侊細鎶曞奖/纭/浼樺厛绾ф祴璇曘€?- [x] AC-B2: 璺敱缁勮 user 娑堟伅鏃惰瘑鍒?image block锛涚洰鏍囨ā鍨嬩笉鏀寔 鈫?鍙戦€佸墠缁撴瀯鍖栭樆鏂紝涓嶈繘鍏?runtime銆傞獙璇侊細璺敱闃绘柇娴嬭瘯 + 娑堟伅涓嶅叆闃熸柇瑷€銆?- [x] AC-B3: 浠讳綍璺緞閮戒笉寰楅潤榛樹涪鍥撅細涓嶆敮鎸佺殑妯″瀷涓嶅墺鍥剧户缁紝澶辫触蹇呭甫鏄庣‘鍘熷洜銆傞獙璇侊細鍏ㄨ矾寰勬柇瑷€娴嬭瘯锛坓rep 鏃犻潤榛樿繃婊わ級銆?
### Phase C: UI 杈撳叆涓庡睍绀?
- [x] AC-C1: composer 鏀寔閫夊浘 + 棰勮 + 绉婚櫎 + 闅忔枃鏈彂閫侊紱闈炴硶鍥剧墖鍦?UI 灞傚嵆鏃舵彁绀恒€傞獙璇侊細UI 娴嬭瘯 + desktop/mobile 璇佹嵁銆?- [x] AC-C2: 娑堟伅鏃堕棿绾挎覆鏌撳浘鐗囷紝鍘嗗彶鍥炴斁/SSE 澧為噺/鍒锋柊鍚庝竴鑷达紱灞曠ず澶辫触鏈夐檷绾ф彁绀恒€傞獙璇侊細browser 璇佹嵁 + 娓叉煋娴嬭瘯銆?
## Dependencies

- **Evolved from**: F002锛圥I SDK host 杩愯鏃?鏂硅█杈圭晫锛宨mage 杈撳叆鎶曞奖渚濊禆鍏?prompt 濂戠害锛夈€?- **Related**: F004锛坈apability registry 浠?catalog modalities 鎶曞奖锛夛紱F003锛堣法鑱婂ぉ瀹?delivery 澶嶇敤 content-block 濂戠害鏃堕渶鍚屾鏀寔鍥剧墖锛夈€?- **Blocked by**: Design Gate 瀵?image 杈撳叆褰㈡€佷笌 capability 钀藉簱璺緞鐨?operator 鎷嶆澘锛堟湰 spec OQ 1/2锛夈€?
## Architecture

```text
composer (file input + preview + remove)
  -> POST /api/conversations/:id/images (multipart, MIME/size/count/filename guard)
  -> controlled upload store (/uploads/)
  -> message { content: text, metadata.contentBlocks: [{type:text}, {type:image,url}] }
  -> capability registry (catalog modalities.input projection -> provider supportsImageInput)
  -> routing: image block present + model lacks vision -> structured block (fail closed)
  -> agent-executor prompt projection -> pi-sdk-host -> model
```

Architecture cell: `server/domain/conversation (messages) + server/domain/models (capability) + server/http (upload static) + public/chat (composer/timeline)`

Map delta: update required

Why: F004 鐨?models cell 鍙鐩?provider 閰嶇疆锛涙湰 Feature 棣栨鎶?鑳藉姏鍒ゅ畾"鍐欒繘 models domain 濂戠害锛屽苟鍦?conversation/messages 寮曞叆 content-block 涓庡彈鎺т笂浼犫€斺€旈渶瑕佹洿鏂?`server/domain/models` 涓庢秷鎭瓨鍌ㄧ殑褰掑睘杈圭晫璇存槑锛屼笉鏂板骞惰 Store/Router銆?
## Eval / Tracking Contract

- **Primary users + activation**: 鑱婂ぉ operator锛沘ctivation 鏄娆￠€夋嫨鍥剧墖骞跺彂閫侊紝鎴栭厤缃?provider 鏃舵煡鐪嬪浘鐗囪兘鍔涖€?- **Friction metric**: 甯﹀浘娑堟伅涓闃绘柇锛堜笉鏀寔妯″瀷锛夋垨灞曠ず澶辫触鐨勫崰姣旓紱涓婁紶琚嫆娆℃暟锛屾寜鍘熷洜鑱氱被銆?- **Regression fixtures**: content-block 鎸佷箙鍖?fixture锛況estart 鍥剧墖鍙揪 fixture锛沜apability 鍒ゅ畾鐭╅樀 fixture锛涢樆鏂紙涓嶅墺鍥撅級fixture锛沀I 閫夊浘/棰勮/绉婚櫎 fixture銆?- **Sunset signal**: 褰?catalog/runtime 浣?capability 鍒ゅ畾鍐椾綑锛堟墍鏈夌洰鏍囨ā鍨嬬粺涓€鏀寔鍥剧墖锛夋椂绉婚櫎 registry 鍒嗘敮锛涙浛鎹㈡柟妗堝繀椤讳繚鐣欎笉鍓ュ浘淇濊瘉涓庝笂浼犲畨鍏ㄣ€?
## Risk

| 椋庨櫓 | 缂撹В |
|------|------|
| 闈欓粯涓㈠浘鎴栧墺鍥剧户缁?| 鍏ㄨ矾寰勬柇瑷€锛氶樆鏂繀甯﹀師鍥狅紝鏃犻潤榛樿繃婊?|
| content-block 鐮村潖鍘嗗彶娑堟伅/FTS/鎽樿 | content 淇濇寔鍏煎锛宑ontentBlocks 鍙仛澧為噺鎵╁睍 |
| 涓婁紶闈㈠紑鏀炬敾鍑伙紙璺緞绌胯秺/SSRF/鐐稿脊锛?| 鍙楁帶鐩綍銆佺櫧鍚嶅崟 MIME銆佸ぇ灏?寮犳暟闄愬埗銆佹棤绗﹀彿瑙ｆ瀽銆佹棤杩滅▼鎶撳彇 |
| PI 涓嶆敮鎸佺粨鏋勫寲 image 杈撳叆 | Design Gate spike 楠岃瘉 prompt hint vs media 鍙傛暟锛涗笉鍓ュ浘 fail closed |
| capability 璇垽锛坈atalog 涓庤繍琛屾椂涓嶇锛?| 鏄惧紡鎶曞奖 + operator 纭 + models.json 浼樺厛锛屾湭鐭?fail closed |

## Open Questions

1. **PI SDK host 濡備綍鎺ユ敹 image 杈撳叆**锛歚session.prompt(prompt)` 鏄瓧绗︿覆銆傚浘鐗囧簲璧?prompt 鍐呰矾寰?hint锛堟ā鍨嬫湁宸ュ叿鍙 uploads 鐩綍锛夈€丼DK media 鍙傛暟锛堣嫢 0.80.10 鏆撮湶锛夈€佽繕鏄秷鎭?content-block 鐩翠紶锛熼渶 spike 楠岃瘉鈥斺€斿喅瀹?adapter 瀹炵幇褰㈡€併€?2. **Capability 钀藉簱褰㈡€?*锛歚supportsImageInput` 浣滀负 `models.json` 椤跺眰甯冨皵瀛楁銆乧atalog-derived 娲剧敓瑙嗗浘銆佽繕鏄繍琛屾椂鍔ㄦ€佸垽瀹氾紵娑夊強 F004"catalog metadata 涓嶉潤榛樺崌绾?runtime 濂戠害"杈圭晫锛岄渶 operator 鎷嶆澘銆?3. **涓婁紶涓庡彂閫佹椂搴?*锛氬厛涓婁紶鎷?URL 鍐嶉殢娑堟伅寮曠敤锛堜袱闃舵锛屽箓绛夋竻鏅帮級锛岃繕鏄秷鎭?multipart 涓€娆℃彁浜わ紙clowder 椋庢牸锛屼簨鍔＄畝鍗曚絾鑰﹀悎锛夛紵
4. **UI 棣栫増鑼冨洿**锛氭枃浠堕€夋嫨鏄惁涓庢嫋鎷?绮樿创鍚?Phase 浜や粯锛岃繕鏄嫋鎷?绮樿创寤跺悗锛?5. **璺ㄨ亰澶╁ delivery**锛欶003 鐨?notify/request 鑻ュ唴瀹瑰惈鍥剧墖锛孭hase A/B 鍚庢槸鍚﹂渶瑕佸悓姝ユ敮鎸侊紝杩樻槸鏄惧紡 non-goal锛?
## Non-goals

- 鍥剧墖鐢熸垚銆佸浘鐗囩紪杈戙€佷换鎰忔枃浠堕檮浠躲€丱CR fallback銆佽棰?闊抽涓婁紶銆?- 涓嶇敤 data URI 鎶婂浘鐗囧杩涙秷鎭綋锛堥槻 DB 鑶ㄨ儉锛夈€?- 涓嶆寜妯″瀷鍚嶇‖缂栫爜 vision 鐧藉悕鍗曪紱涓嶆妸 provider 宸紓娉勬紡鍒?UI/store銆?- 棣栫増涓嶈繛 Redis 6399銆佷笉鐢ㄧ敓浜х敤鎴锋暟鎹紱鎵€鏈夋祴璇曠敤闅旂瀛樺偍銆?