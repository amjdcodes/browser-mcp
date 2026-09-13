# تقرير مراجعة خطة إضافة الأدوات الأربع (`browser_resize` · `browser_evaluate` · `browser_hover` · `browser_press`)

> **مراجعة نقدية مستقلة مبنية على استكشاف كامل للمشروع واختبارات فعلية على الكود الحقيقي.**
> لم يُعدَّل أي ملف من ملفات المشروع أثناء إعداد هذا التقرير؛ القياسات أُجريت عبر استيراد `src/browser.js` كما هو، وكل مخرجات الاختبارات موثّقة في الملحق.
>
> - **التاريخ:** 2026-09-13
> - **الفرع:** `updates`
> - **الملف المراجَع:** `docs/plans/plan.md` (429 سطراً)
> - **البيئة:** Node.js v26.2.0 · Chromium 150.0.7871.100 (Debian 12) · aarch64
> - **الحكم الإجمالي:** الخطة **جيدة الهيكل وصحيحة في معظم تشخيصاتها**، لكنها تحتوي **على عيبين حرجين (P0)** يجعلان بعض السيناريوهات المعلنة **تفشل فعلياً**، وثغرة تصميمية واحدة (P1). بعد معالجة النقاط الأربع الأساسية المذكورة أدناه تصبح الخطة **آمنة للتنفيذ**.

---

## 1. الملخّص التنفيذي

الخطة تهدف إلى توسيع المشروع من 9 أدوات إلى 13 بإضافة `browser_resize` و`browser_evaluate` و`browser_hover` و`browser_press`، مع بنية تحتية جديدة (`src/viewport.js`, `src/keymap.js`)، وإدارة حالة viewport دائمة، وبوابة أمان لتنفيذ JavaScript.

**ما نجح في الخطة (مؤكَّد بالدليل):**
- تشخيصها للخطر الأخطر (مسح `browser_resize` بعد أي لقطة `full_page`) **صحيح 100%**، وقد أثبتُّ ذلك عملياً: بعد ضبط مقاس `500×700` ثم محاكاة `clearDeviceMetricsOverride`، عاد المتصفح إلى `780×437`.
- تشخيصها لغياب `Input.dispatchKeyEvent` كمهارة ناقصة **صحيح**.
- قراءتها للوضع الحالي (9 أدوات، بوابة `ENABLE_EVAL_JS` محجوزة، اختبار `${`، عدّاد أدوات مرن، أول زر في الفيكستشر) **مطابقة للكود**.
- اختيار `_reapplyViewport` عبر `this.cdp.send` (لا `this.send`) **قرار هندسي دقيق** لأن الحالة قد تكون `reconnecting`.

**ما يفشل فيها (مؤكَّد بالدليل):**
1. **(P0) انهيار فعلي في `browser_screenshot`:** خطة الـ resize تسمح بمقاسات ≤ `10000×10000`، لكن مسار اللقطة الجزئية (viewport) يحتوي على خطأ قائم: عند تجاوز `MAX_SCREENSHOT_PIXELS` ينفّذ `clip.scale = …` بينما `clip` **غير معرّف** في هذا المسار → `TypeError`. أي لقطة viewport بعد resize كبير تنهار. وبهذا فإن مزاعم الخطة «الحدود تمنع تجاوز `MAX_SCREENSHOT_PIXELS`» **غير صحيحة** (`10000×10000 = 100M` بكسل، أي 6.25 أضعاف الحد).
2. **(P0) قيم zod الافتراضية تُبطل منطق التحقق الحصري:** لأن `reset` و`mobile` و`device_scale_factor` معرفة بـ `.default()`، فإن أي نداء — حتى `{}` — يصل إلى المعالج وقد امتلأ بالقيم الافتراضية. لذا «`reset` لا يقبل خيارات أخرى» سيُرفض دائماً، و«لا شيء → `INVALID_ARGS`» لا يمكن اكتشافه من الكائن المُحلَّل.
3. **(P1) `deviceScaleFactor` يضاعف دقة اللقطة دون علم فحص الحدود:** أثبتُّ عملياً أن dSF=3 يحوّل لقطة `500×700` إلى `1500×2100`. الخطة تضبط dSF=3 للجوال و2 للتابلت، لكن فحص `MAX_SCREENSHOT_PIXELS` يحسب بالـ CSS pixels فقط، و`MAX_IMAGE_BYTES` **غير مطبَّق أصلاً** في مسار اللقطات.
4. **(P1) خطر إفشال اختبار قائم عبر الفيكستشر:** مستمع `keydown` الذي تخطط لإضافته يجب ألا يستدعي `preventDefault()` وإلا توقّف إرسال النموذج بـ Enter وأفشل اختبار `#form-result`/`#click-result`.

**ملاحظة مهمة:** الخطأ الأول (P0-1) **ليس من صنع الخطة**، لكن الخطة هي التي تُفعّل الوصول إليه. إغفاله يعني أن أول تجربة حقيقية لـ resize كبير + لقطة جزئية ستنتهي برسالة خطأ غامضة.

---

## 2. المنهجية والنطاق

| الخطوة | ما تم فعلياً |
|---|---|
| استكشاف البنية | قراءة كاملة لـ `index.js` (1172 سطراً)، `src/{browser,cdp,helpers,utils,lock,console-buffer}.js`، كل ملفات `tests/*` (16 ملفاً)، `fixtures/test-page.html`، `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `.env.example`, `opencode.json` |
| قراءة الخطة | `docs/plans/plan.md` وتقرير الأصل `docs/BROWSER_TOOL_FEEDBACK.md` |
| الاختبار المرجعي | `npm test` كامل → **180/180 نجحت، 0 فشل**، الزمن 260 ثانية |
| فحص بيئي | Node v26.2.0 · Chromium 150 · `ENABLE_EVAL_JS` غير مضبوط |
| اختبار zod (بلا Chromium) | محاكاة مخطط `browser_resize` المقترح لمعرفة سلوك القيم الافتراضية |
| اختبار viewport (Chromium حقيقي) | استيراد `Browser` مباشرةً وقياس `innerWidth/Height` و`devicePixelRatio` وأبعاد اللقطة في 6 حالات |
| تحقق ثابت | `grep` لعدّادات الأدوات، وجود `${`، استيرادات `node:fs`، مواضع `registerTool` |

> **قيد مهم:** لم أنفّذ أي تغيير على الكود، ولم أُضِف الأدوات الأربع (كما طُلب). كل ما ورد من «فشل» هو إمّا استنتاج مباشر من مسار الكود مع أرقام محسوبة، أو قياس فعلي documented في الملحق.

---

## 3. الوضع الحالي (حقائق مؤكَّدة مقابل الكود)

- **9 أدوات** مسجّلة فعلاً عبر `registerTool` (تحقّقت بالعدّ المباشر في `index.js`).
- نمط المعالج القياسي: `validate → ensureBrowserReady() → انتظار navigationPromise → CDP → resetIdleTimer()`.
- القفل `runLocked()` على: `navigate`, `click`, `type`, و`screenshot` فقط عند `full_page`.
- `browser_screenshot (full_page)` **يفعل بالضبط** ما وصفته الخطة: يضبط `Emulation.setDeviceMetricsOverride` (dSF=1) ثم يمسحه في `finally` عبر `Emulation.clearDeviceMetricsOverride` (الأسطر 624–667).
- `Runtime.evaluate` / `Runtime.callFunctionOn` مستخدمان في معظم الأدوات؛ `Input.dispatchMouseEvent` في `clickElement`؛ **`Input.dispatchKeyEvent` غير موجود إطلاقاً**.
- `helpers.test.js` يفرض أن كل مفتاح في `IN_PAGE` نص دالة يبدأ بـ `function(` وخالٍ من `${` (الأسطر 67–80).
- `mcp-handshake.test.js` يتحقق فقط من `tools.length > 0` (السطر 97) → إضافة الأدوات آمنة.
- أول `<button>` في الفيكستشر هو `#submit-btn` (السطر 119) → إضافة عناصر في نهاية `<body>` قرار سليم.
- `.env.example` (40–44) و`README.md` (263, 391) يوثّقان `ENABLE_EVAL_JS` كمتغيّر **محجوز وغير منفّذ**.
- **`ARCHITECTURE.md` غير متّسق داخلياً:** السطر 5 يقول **«8 tools»** بينما السطر 53 يسرد 9 أدوات، و`README`/`index.js` يقولان 9. (انحراف توثيقي قائم.)
- `screenshots/` و`node_modules/` و`.commandcode/` في `.gitignore`؛ `docs/` **غير متتبَّع** حالياً (`?? docs/`).

---

## 4. المزاعم التي تحقّقتُ منها وتطابق الكود

| المزعم في الخطة | النتيجة | الدليل |
|---|---|---|
| 9 أدوات مسجّلة | ✅ صحيح | 9 استدعاءات `registerTool` |
| `Emulation` مستخدم في full-page ويُمسح في `finally` | ✅ صحيح | `index.js:628,665` |
| `Input.dispatchKeyEvent` هو الناقص الوحيد | ✅ صحيح | لا وجود له في المشروع |
| `ENABLE_EVAL_JS` محجوز في `.env.example` | ✅ صحيح | `.env.example:40-44` |
| `helpers.test.js` يرفض `${` في `IN_PAGE` | ✅ صحيح | `tests/helpers.test.js:74-80` |
| `mcp-handshake` يتحقق فقط من `length > 0` | ✅ صحيح | `tests/mcp-handshake.test.js:97` |
| أول زر = `#submit-btn`، فأضف في النهاية | ✅ صحيح | `fixtures/test-page.html:119` |
| `README` يقول «nine tools» في مواضع عدة | ✅ صحيح | الأسطر 21, 31, 83, 102 |
| «مسح resize بعد full_page» خطر حقيقي | ✅ **مؤكَّد عملياً** | probe: `500×700` → `clear` → `780×437` |
| resize يبقى بعد navigation | ✅ **مؤكَّد عملياً** | probe: `500×700` بعد `Page.navigate` |

---

## 5. المشاكل الحرجة (P0)

### P0-1 — انهيار `browser_screenshot` (viewport) عند resize كبير: `clip` غير معرّف

**الموقع:** `index.js:581-596`.

```js
const totalPixels = (clip ?? captureSize).width * (clip ?? captureSize).height;
if (totalPixels > MAX_SCREENSHOT_PIXELS) {
  const scaleFactor = Math.sqrt(MAX_SCREENSHOT_PIXELS / totalPixels);
  clip.scale = scaleFactor;      // ← clip === undefined في مسار الـ viewport
  truncated = true;
  ...
}
```

في مسار اللقطة الجزئية (غير `full_page`) لا يُبنى `clip` أبداً (يُترك `undefined`)، ويُعتمد على `captureSize`. الحدث `if` لا يُفعَّل اليوم لأن المقاس الافتراضي `780×437 ≈ 0.34M` بعيد جداً عن `16M`. لكن بمجرد إضافة `browser_resize` بحد أقصى `10000×10000 = 100M`، تصبح أي لقطة viewport لمقاس أكبر من `16M` **خطأ وقت تشغيل** (`TypeError: Cannot set properties of undefined (setting 'scale')`)، ويُرجعه المعالج كرسالة خطأ بلا كود واضح.

**لماذا يخصّ الخطة:** جدولها في §3 يدّعي أن حدود المقاس «تمنع إساءة الاستخدام ويتجنّب تجاوز `MAX_SCREENSHOT_PIXELS` بشكل غير متوقع» — **هذا غير صحيح حسابياً** (`10000×10000 = 6.25×` الحد). المعالجات المقترحة (preset mobile مثلاً `390×844`) آمنة، لكن المسار الصريح غير آمن.

**الإصلاح المطلوب (يُدرج في الخطة):**
- إمّا تضييق الحد إلى `Math.floor(Math.sqrt(MAX_SCREENSHOT_PIXELS))` ≈ **4000** (بعد احتساب `deviceScaleFactor²`)، أو
- إصلاح المسار نفسه: عندما `clip === undefined` لا توجد طريقة لتصغير اللقطة عبر `clip.scale` (وREADME يمنع تمرير clip في viewport). الحل العملي: **رفض** اللقطة الجزئية التي تتجاوز الحد برسالة `INVALID_ARGS`/`VIEWPORT_TOO_LARGE` صريحة، أو فرض `captureBeyondViewport` مؤقتاً مع clip وتصغيره، أو تثبيت `deviceScaleFactor=1` أثناء الالتقاط.
- إضافة اختبار انحدار: `resize(width=5000,height=5000)` ثم `browser_screenshot` يجب أن يعيد نتيجة مفهومة (نجاح مصغَّر أو خطأ واضح)، لا `TypeError`.

### P0-2 — القيم الافتراضية في zod تُبطل منطق «الطرق الحصرية» لـ `browser_resize`

**الدليل العملي (برنامج اختبار على المخطط المقترح نفسه):**

```
{"reset":true}                     => {"device_scale_factor":1,"mobile":false,"reset":true,"timeout_ms":10000}
{"preset":"mobile"}                => {"preset":"mobile","device_scale_factor":1,"mobile":false,"reset":false,"timeout_ms":10000}
{"width":500,"height":700}         => {"device_scale_factor":1,"mobile":false,"reset":false,"timeout_ms":10000}
{}                                 => {"device_scale_factor":1,"mobile":false,"reset":false,"timeout_ms":10000}
{"reset":true,"width":500,"height":700} => {..., "reset":true, "width":500, "height":700, ...}
```

بما أن MCP SDK يتحقّق عبر ZodObject ويمرّر **الناتج المُطبَّع** إلى المعالج، فإن `device_scale_factor` و`mobile` و`reset` ستكون **موجودة دائماً**. وعليه:

- قاعدة «`reset` لا يُقبل مع أي خيار آخر» ستعتبر `device_scale_factor:1` و`mobile:false` خياراتٍ مُقدَّمة → **`reset` سيُرفض دائماً**.
- قاعدة «إن لم يُقدَّم أي شيء → `INVALID_ARGS`» **مستحيلة** من الكائن المُحلَّل، لأن `{}` يبدو مطابقاً لمقاس صريح ناقص.
- كذلك لا يمكن التمييز بين `preset` مع `mobile` الصريح وبين الافتراضي.

**الإصلاح المطلوب:**
- إمّا إزالة `.default()` من الحقول الحسّاسة في المخطط وتطبيق الافتراضات داخل `resolveViewportParams`، أو
- فحص الطرق على **مفاتيح المدخل الخام** (`Object.keys(rawArgs)`)، أو
- استخدام `.refine()`/`.superRefine()` على المخطط بحيث يتم التحقق **قبل** تطبيق الافتراضات.
- إضافة اختبارات وحدة للحالات: `{}`، `{reset:true}`، `{reset:true,width:1,height:1}`، `{preset:'mobile',width:1}`، `{width:1}`، `{height:1}`.

---

## 6. مشاكل عالية الأولوية (P1)

### P1-1 — `deviceScaleFactor` يضاعف دقة الصورة والفحوصات لا تعلم

**قياس فعلي (probe):**

```
screenshot dSF=1 : {"width":500,"height":700,"bytes":4591}
screenshot dSF=3 : {"width":1500,"height":2100,"bytes":19782}
```

- `MAX_SCREENSHOT_PIXELS` يُحسب من `Page.getLayoutMetrics` (CSS px)، بينما الصورة الناتجة تُضرب في `dSF²`. الجوال `390×844 @3 = 2.96M` فعلي مقابل `329K` محسوب، والتابلت `768×1024 @2 = 3.15M` مقابل `786K`.
- `MAX_IMAGE_BYTES` **غير مطبَّق** في مسار `browser_screenshot` أصلاً (لا `truncateBuffer` على صورة اللقطة) — وهذا يعني أن dSF عالٍ مع مقاس كبير قد يُنتج payload ضخماً يستهلك ذاكرة ونقل stdio بلا حد.
- في `full_page` الخطة «تثبّت `mobile:false` وقت الالتقاط» لكنها **لا توضّح مصير `deviceScaleFactor`**؛ الكود الحالي يفرض `deviceScaleFactor:1` داخل override اللقطة الكاملة، وهذا جيد — لكنه يجب أن يُنصّ عليه صراحةً في الخطة.
- التوصية: أثناء الالتقاط ثبّت `deviceScaleFactor:1`، أو اضرب حساب البكسل في `dSF²`، وأضِف تطبيقاً فعلياً لـ `MAX_IMAGE_BYTES` على اللقطات.

### P1-2 — مستمع `keydown` في الفيكستشر قد يُفشل اختبارات قائمة

الخطة تقترح `#key-result` مع مستمع على `document` يسجّل المفاتيح. إن استدعى المستمع `preventDefault()` (أو أوقف انتشار المفتاح) فإن:
- `Enter` داخل `#form-input` لن يُرسل `#interaction-form`، وبالتالي لن يتحدّث `#click-result` → يفشل اختبار press المقترح نفسه.
- الاختبارات القائمة على إرسال النماذج (Phase 4 / `interaction-form`) قد تتأثر.

**التوصية:** في الفيكستشر، سجّل المفاتيح **دون** `preventDefault`، واشترط في الخطة أن أي `preventDefault` يكون مقصوراً على عناصر جديدة خارج `#interaction-form`.

### P1-3 — الاعتماد على «أول زر» اختبار ضعيف لكن يجب احترامه

لاحظت أن الاختبار القائم `clicks the first element when a selector matches multiple` يكتفي بـ `text.length > 0` وهو شرط **تافه يتحقق دائماً**، لذا ليس هشاً فعلياً كما تظن الخطة. ومع ذلك، إضافة العناصر في نهاية `<body>` كما تخطط **صحيحة واحتياطية جيدة**. لا تغيير مطلوب، فقط توضيح أن المخاطرة أقل مما ورد في جدول §11.

### P1-4 — `browser_evaluate` عند تفعيله يخالف التعهّد الأمني المعلن

الخطة تعالج هذا بالبوابة المعطّلة افتراضياً وتوثيق SSRF/قراءة البيانات — وهذا **سليم**. لكن يجب ألا يبقى في `ARCHITECTURE.md` بند «Security Model → No Remote Code Execution» بصيغته المطلقة؛ الخطة تذكر تحديث الأدوات/الـ env في ARCHITECTURE لكنها لا تذكر صراحةً تعديل **قسم الأمان**. أضِف ذلك، لأن هذا الملف هو ما يقرأه الوكلاء (مُدرج في `opencode.json`).

---

## 7. أخطاء قائمة كشفها الاستكشاف (الخطة تلمس ملفاتها فتجب معالجتها)

### 7.1 `readdirSync` مستخدم وغير مُستورد في `src/browser.js` — شبكة حماية «عمليات Chromium المعلّقة» معطّلة صامتاً

- السطر 2 يستورد: `{ existsSync, readFileSync, rmSync, mkdtempSync }` — **بدون `readdirSync`**.
- السطر 402: `for (const entry of readdirSync('/proc'))` داخل `_killChildrenByProfile`.
- النتيجة: `ReferenceError` في كل نداء، يُبتلع داخل `catch {}` (السطر 419) → الدالة **لا تقتل أي عملية يتيمة فعلياً**، ثم يتبعها `rmSync` بإعادة المحاولة. هذا يفسّر لماذا تمر اختبارات التنظيف عادةً (SIGTERM للمجموعة كافٍ)، لكنه يُبقي احتمال عمليات Chromium يتيمة حقيقياً عند الحالات الحدّية.
- **يخصّ الخطة:** لأنها تعدّل `src/browser.js` وتضيف `_reapplyViewport`، من المنطقي إصلاح الاستيراد في نفس الـ PR، خصوصاً أن جدول المخاطر يَعِد بـ«عدم ترك عمليات Chromium متبقية». اختبار `cleanup` القائم لن يكشفه.

### 7.2 `require()` داخل وحدة ESM في `getChromiumVersion` — كود ميت
- `src/browser.js:92` يستخدم `require('node:child_process')` داخل وحدة `"type":"module"` → `ReferenceError` يُبتلع ويُعيد `'unknown'`. الدالة غير مُستدعاة في أي مكان. يُفضَّل حذفها (لا علاقة مباشرة بالخطة لكنها تشويش).

### 7.3 انحراف توثيقي
- `ARCHITECTURE.md:5` «8 tools» مقابل 9 فعلياً. عند التحديث إلى 13 يجب تصحيح الأساس أولاً.
- الخطة تقول إن `reset` يعيد «`800x600` تقريباً»؛ القياس الفعلي هو **`780×437`**. لا تُثبّت أرقاماً في التوثيق؛ صِفها كـ«الأبعاد الافتراضية لـ Chromium headless في هذه البيئة».

---

## 8. تقييم خطة الاختبارات

**نقاط قوة:** تغطية وحدة/تكامل ممتازة، اختبار انحدار حرج للـ viewport بعد `full_page`، اختبار تدفّق البوابة (معطّلة/مفعّلة)، قصّ الناتج، والاستثناءات. توزيع الأدوات على 5 ملفات منطقي، وربط الاختبارات القائمة (helpers/utils) صحيح.

**فجوات يجب سدّها:**
1. **لا اختبار للحد الأقصى للمقاس** (`10000×10000`) مع لقطة viewport → لن يكشف P0-1.
2. **لا اختبار لـ `deviceScaleFactor`** وأثره على أبعاد الصورة/الحجم (P1-1).
3. **اختبار «البوابة معطّلة» يجب أن يضبط `ENABLE_EVAL_JS` صراحةً إلى `''`** عند spawn؛ وإلا فوّض `process.env` الموروث قد يجعل الاختبار غير حتمي في CI.
4. **اختبار `{}` و`{reset:true,…}`** لـ resize إلزامي لكشف P0-2.
5. **اختبار أن الفيكستشر لا يعطّل Enter** (إرسال النموذج يحدّث النتيجة) — وهذا مغطّى جزئياً لكن أضِفه صراحةً ضمن press.
6. **اختبار إعادة تطبيق viewport بعد crash/restart** (وليس فقط WS-drop): القياس يثبت أن override يبقى بعد WS reconnect، لذا الاختبار المهم هو **إعادة التشغيل**.
7. توثيق أن `npm test` الحالي يستغرق ~4.3 دقيقة و180 اختباراً مع 3 تزامن؛ إضافة 5 ملفات تكامل ستزيد الزمن وعدد عمليات Chromium — يستحسن مراجعة `--test-concurrency` أو تقسيم الملفات.

---

## 9. مصفوفة المخاطر المحدّثة

| # | الخطر | الاحتمال | الأثر | التقييم | التخفيف المقترح |
|---|---|---|---|---|---|
| P0-1 | `TypeError` في لقطة viewport بعد resize كبير | مرتفع إن نُفّذ resize كبير | مرتفع | **حرج** | تضييق الحد إلى ~4000/dSF أو رفض/تصغير صريح + اختبار انحدار |
| P0-2 | `reset` مرفوض دائماً ولا شيء لا يُكتشف | مؤكد (بنية zod) | مرتفع | **حرج** | إزالة `.default()` الحسّاسة أو فحص المدخل الخام/`superRefine` |
| P1-1 | تضخّم الصور وحساب بكسل خاطئ مع dSF | مرتفع | متوسط/مرتفع | عالٍ | تثبيت dSF=1 عند الالتقاط + احتساب dSF² + تطبيق `MAX_IMAGE_BYTES` |
| P1-2 | مستمع keydown يعطّل إرسال النموذج | متوسط | متوسط | عالٍ | منع `preventDefault` في الفيكستشر |
| P1-3 | بقاء بند «No Remote Code Execution» مطلقاً في ARCHITECTURE | متوسط | متوسط | متوسط | تحديث قسم Security Model |
| P1-4 | `readdirSync` معطّل → يتيمة محتملة | منخفض | متوسط | متوسط | إصلاح الاستيراد في نفس PR |
| P2-1 | مزعم «فقدان Emulation عند إعادة الاتصال» غير دقيق | — | منخفض | منخفض | توثيق أن WS-reconnect يحتفظ بالـ override، وأن crash-restart يحتاج الإعادة |
| P2-2 | `MAX_EVAL_LENGTH` بدلالتين (طول التعبير/قصّ الناتج) | متوسط | منخفض | منخفض | فصل الثابتين أو توضيح الدلالة |
| P2-3 | `timeout_ms` في مخطط resize غير مستخدم في `applyViewport` | متوسط | منخفض | منخفض | تمريره أو حذفه |
| P2-4 | ازدحام القفل بإقفال resize/evaluate/hover/press | منخفض | منخفض | مقبول | مقايضة موثّقة |

---

## 10. الحكم النهائي والتوصيات المرتبة

**الحكم:** الخطة **صحيحة التوجّه وجيدة التغطية**، وتحلّ بالفعل أكبر مشكلتين في تقرير التغذية الراجعة (التحكم بالمقاس + تنفيذ JS). لكنها **غير جاهزة للتنفيذ كما هي** لأنها تحتوي على عيبين حرجين يجعلان جزءاً من سلوكها المعلن يفشل، ولا سيما:

- `browser_resize` بحدوده المعلنة + `browser_screenshot` الجزئية = انهيار.
- `browser_resize` بالتحقق الحصري المعتمد على الناتج المُطبَّع = رفض `reset` دائماً.

**قائمة إصلاح إلزامية قبل البدء:**
1. **[P0]** تحديد سلوك اللقطات الجزئية عند تجاوز حد البكسل (رفض صريح أو تضييق الحد إلى ≈4000) + اختبار انحدار.
2. **[P0]** إعادة تصميم تحقق `browser_resize` ليعتمد على المدخل الخام أو `superRefine`، مع اختبارات `{}` و`reset+…`.
3. **[P1]** حسم أثر `deviceScaleFactor` على أبعاد/حجم الصورة، وتطبيق `MAX_IMAGE_BYTES` على اللقطات.
4. **[P1]** ضمان أن مستمع المفاتيح في الفيكستشر لا يعطّل إرسال النموذج.
5. **[P1]** تصحيح قسم الأمان في `ARCHITECTURE.md` وإصلاح `readdirSync`.
6. **[P2]** تصحيح ادّعاء إعادة الاتصال، وتوحيد `MAX_EVAL_LENGTH`، واستخدام/حذف `timeout_ms` في resize.

**قرار مقترح:** **تنفيذ مشروط (Conditional Go).** المراحل 0/1 من الخطة (ملفان جديدان + بنية تحتية) آمنة ويمكن البدء بها فوراً. لا تبدأ المرحلة 2 (تسجيل الأدوات) قبل إنجاز البندين P0.

---

## 11. ملحق — الأدلة الخام

### أ) الاختبار المرجعي
```
$ npm test
ℹ tests 180      ℹ pass 180      ℹ fail 0
ℹ duration_ms 260440
```
(الخروج بالرمز 0.)

### ب) probe الـ viewport (Chromium حقيقي، استيراد `Browser` كما هو)
```
baseline              : {"w":780,"h":437,"dpr":1}
after resize 500x700  : {"w":500,"h":700,"dpr":1}
after navigation      : {"w":500,"h":700,"dpr":1}     ← resize يبقى بعد navigation
after full-page clear : {"w":780,"h":437,"dpr":1}     ← resize يُمحى بـ clearDeviceMetricsOverride
screenshot dSF=1      : {"width":500,"height":700,"bytes":4591}
screenshot dSF=3      : {"width":1500,"height":2100,"bytes":19782}  ← الدقة تتضاعف
after WS reconnect    : {"w":500,"h":700,"dpr":1}     ← الـ override لم يُفقد على reconnect
```

### ج) probe zod
```
{"reset":true}    => {"device_scale_factor":1,"mobile":false,"reset":true,"timeout_ms":10000}
{"preset":"mobile"}=> {"preset":"mobile","device_scale_factor":1,"mobile":false,"reset":false,"timeout_ms":10000}
{}                => {"device_scale_factor":1,"mobile":false,"reset":false,"timeout_ms":10000}
```

### د) تأكيد عيب الاستيراد
```
imports:
  import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
uses readdirSync: true
readdirSync imported: false
uses require(): true
```

---

## 12. ملحق ب — نطاق لم تُغطّه الخطة (اقتراحات لاحقة)

- `browser_get_network` (ورد في تقرير التغذية الراجعة).
- توضيح إحداثيات `browser_click` بعد التمرير التلقائي.
- `wait_until` / انتظار `document.fonts.ready` قبل اللقطة.
- `browser_get_attributes` (يمكن تغطيته جزئياً بـ `browser_evaluate`).
- تجميع الإجراءات في نداء واحد.

---

*أُعدَّ هذا التقرير دون أي تعديل على ملفات المشروع. جميع المقاطع البرمجية المرجعية مقتبسة من الحالة الحالية للفرع `updates`.*
