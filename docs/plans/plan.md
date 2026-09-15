# خطة إضافة أدوات: `browser_resize` · `browser_evaluate` · `browser_hover` · `browser_press`

> خطة تنفيذية احترافية مبنية على استكشاف كامل للمشروع (`index.js`, `src/*`, `tests/*`, `fixtures/*`, `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `.env.example`) وقراءة تقرير `docs/BROWSER_TOOL_FEEDBACK.md`.
>
> **الحالة:** مقترح خطة — لم يُكتب أي كود بعد.
> **نطاق العمل:** إضافة 4 أدوات جديدة (9 → 13) + كل ما يلزم من بنية تحتية واختبارات وتوثيق، دون كسر أي سلوك قائم.

---

## 1. الملخّص التنفيذي

التقرير يرتّب الفجوات كالتالي: **P0** التحكم بمقاس العرض (`browser_resize`) وتنفيذ JavaScript (`browser_evaluate`)، ثم **P1** حالات الـ hover والتنقل بلوحة المفاتيح (`browser_hover` / `browser_press`). هذه الأدوات الأربع هي بالضبط المطلوب، وهي المتمّمة الطبيعية للبنية الحالية لأن كل ما تحتاجه موجود أصلاً في المشروع:

- `Emulation.setDeviceMetricsOverride` مُستخدَم فعلاً في `browser_screenshot` (full page) — سنبني عليه `browser_resize` كمصدر دائم للـ viewport.
- `Runtime.evaluate` و `Runtime.callFunctionOn` مُستخدَمان في كل الأدوات تقريباً — سنبني عليهما `browser_evaluate` مع طبقة تسلسل نتائج آمنة.
- `Input.dispatchMouseEvent` مُستخدَم في `browser_click` — سنبني عليه `browser_hover` بإعادة استخدام نفس منطق النقر الآمن (scroll → settle → hit-test).
- `Input.dispatchKeyEvent` هو القدرة الوحيدة الناقصة تماماً — سنضيف `src/keymap.js`.

**أهم 3 نقاط حرجة يجب حلّها بشكل صحيح:**

1. **تعارض الـ viewport**: `browser_screenshot` بوضع `full_page` يضبط `Emulation` ثم **يمسحه** (`clearDeviceMetricsOverride`) في `finally`. إذا أضفنا `browser_resize` دون تعديل هذا السلوك، فسيمسح الـ resize بعد أول لقطة كاملة. الحل: تخزين حالة الـ viewport في `Browser` واستعادتها بدل المسح.
2. **أمان `browser_evaluate`**: المشروع يعلن صراحةً "No arbitrary code execution" و`.env.example` يوثّق `ENABLE_EVAL_JS` كمتغيّر محجوز لهذا الغرض. الحل: الأداة **معطّلة افتراضياً** وتُفعَّل عبر `ENABLE_EVAL_JS=1`، مع توثيق مخاطر SSRF/قراءة `localStorage`.
3. **`Emulation` يُفقد عند الانهيار/إعادة الاتصال**: بعد crash أو WS-drop تُعاد تهيئة الصفحة، لذا يجب إعادة تطبيق الـ viewport داخل `_connectToPage()`.

---

## 2. الوضع الحالي (المرجع السريع)

- **9 أدوات** مسجّلة في `index.js` عبر `registerTool(name, description, schema, handler)`.
- نمط كل معالج: `validate → ensureBrowserReady() → انتظار navigationPromise → إرسال CDP/Runtime → resetIdleTimer() → إرجاع JSON`.
- **القفل** `runLocked()` يُستخدم للعمليات المُغيّرة للحالة: `navigate` (دائماً)، `screenshot` (فقط `full_page`)، `click`، `type`. القراءة لا تُقفل.
- **الحدود** في `src/utils.js` عبر `envInt()` وتُصدَّر في `CONFIG`، والأخطاء في `ERRORS`.
- **الأمان**: selectors/text تُمرَّر كـ CDP `arguments` ولا تُدمج في الكود أبداً. القاعدة مؤكَّدة باختبار في `tests/helpers.test.js` يرفض وجود `${` في نصوص `IN_PAGE`.
- **الاختبارات**: `node:test` + `node:assert/strict`، `npm test` بتزامن 3، والتكامل يفتح خادم MCP حقيقي + خادم fixture + Chromium حقيقي. `mcp-handshake.test.js` يتحقق فقط من `tools.length > 0`، لذا إضافة الأدوات لن تكسر عدداً مفروضاً.
- **fixtures**: `fixtures/test-page.html` هو الصفحة المشتركة. اختبار "أول زر" يعتمد على أن أول `<button>` هو `#submit-btn`، لذا أي عناصر جديدة تُضاف **في نهاية `<body>`** فقط.

---

## 3. القرارات التصميمية الرئيسية

| القرار | الاختيار | المبرّر |
|---|---|---|
| بوابة `browser_evaluate` | معطّلة افتراضياً عبر `ENABLE_EVAL_JS` | يحافظ على تعهّد المشروع الأمني؛ تفعيل بأمر واحد في MCP client |
| أقفال الأدوات الجديدة | `resize` ✅ / `evaluate` ✅ / `hover` ✅ / `press` ✅ | كلها قد تغيّر الحالة (evaluate ينفّذ JS عشوائي، hover يفتح قوائم، press يُدخل نصاً) |
| مصدر حالة الـ viewport | `Browser.viewport` (كائن واحد) | يعيش مع الكائن `Browser` ويُعاد تطبيقه تلقائياً بعد start/reconnect |
| حفظ الـ resize بعد الطيّ/إعادة التشغيل | يبقى محفوظاً في `Browser` ولا يُمسح في `cleanup()` | تجربة متّسقة في نفس الجلسة؛ موثّق صراحةً |
| تسلسل نتيجة `evaluate` | `Runtime.evaluate` (`returnByValue:false`) ثم دالة تسلسل ثابتة عبر `callFunctionOn` | يتعامل مع DOM/الدوال/circular/BigInt دون كسر، ويحافظ على قاعدة "لا دمج مدخلات في الكود" |
| تنفيذ ضغطة المفتاح | `Input.dispatchKeyEvent` (`keyDown` بنص للأحرف، `rawKeyDown` لغيرها، ثم `keyUp`) | أسلوب Puppeteer المعياري لضمان إطلاق `input`/`submit` |
| حدود المقاس | 100–10000 بكسل، `deviceScaleFactor` 1–4 | يمنع إساءة الاستخدام ويتجنّب تجاوز `MAX_SCREENSHOT_PIXELS` بشكل غير متوقع |

---

## 4. المواصفات التفصيلية لكل أداة

### 4.1 `browser_resize` — التحكم بمقاس العرض (P0)

**الوصف للمستخدم:** `Resize the browser viewport (width/height, presets, or reset to default)`.

**الـ Schema المقترح (محدَّث — بلا `.default()`):**

```js
{
  preset: z.enum(['mobile', 'tablet', 'desktop']).optional(),
  width:  z.number().int().min(100).max(10000).optional(),
  height: z.number().int().min(100).max(10000).optional(),
  device_scale_factor: z.number().min(1).max(4).optional(),
  mobile: z.boolean().optional(),
  reset:  z.boolean().optional(),
  timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional()
}
```

> ⚠️ **لا تستخدم `.default()` على هذه الحقول.** أثبت الاختبار العملي أن القيم الافتراضية تصل إلى المعالج فتُبطل التمييز بين «صريح» و«افتراضي»؛ النتيجة: `reset` يُرفض دائماً ويستحيل اكتشاف نداء فارغ `{}`. تُطبَّق الافتراضات داخل `resolveViewportParams(args)` **بعد** التحقق (انظر §13).

**قواعد التحقق (ترجع `INVALID_ARGS`):**
- ثلاث طرق حصرية: `reset` **أو** `preset` **أو** (`width` + `height`).
- `preset` لا يُقبل مع `width`/`height`.
- `width` بدون `height` (أو العكس) مرفوض.
- `reset` لا يُقبل مع أي خيار آخر.
- إن لم يُقدَّم أي شيء → `INVALID_ARGS`.

> **التحقق يجري على المدخل الخام** عبر `resolveViewportParams(args)` في `src/viewport.js` (وليس على ناتج Zod المُطبَّع).

**الإعدادات الجاهزة (`preset`):**

| preset | width | height | mobile | deviceScaleFactor |
|---|---|---|---|---|
| `mobile` | 390 | 844 | true | 3 |
| `tablet` | 768 | 1024 | true | 2 |
| `desktop` | 1280 | 800 | false | 1 |

**السلوك:**
- `reset`: `Emulation.clearDeviceMetricsOverride` + `browser.viewport = null`.
- غير ذلك: `browser.applyViewport({width, height, deviceScaleFactor, mobile})` التي تنفّذ:
  `Emulation.setDeviceMetricsOverride { width, height, deviceScaleFactor, mobile }` وتخزّن الحالة.
- ينتظر frame واحد (`waitForSettle`) بعد التطبيق ليصبح التصميم مستقراً قبل أي لقطة تالية.

**الناتج:** `{ resized: true, width, height, deviceScaleFactor, mobile, preset: preset ?? null, reset }`.

**الأخطاء:** `INVALID_ARGS`, `VIEWPORT_APPLY_FAILED` (فشل CDP), `BROWSER_NOT_READY`.

**القفل:** نعم.

**لماذا يحلّ المشكلة:** يستبدل الحل الالتوائي في التقرير (نسخ الملف + `sed` + خادم منفصل) بأمر واحد، ويفتح اختبار `@media (min-width: 640/900/1200)` مباشرة.

---

### 4.2 `browser_evaluate` — تنفيذ JavaScript داخل الصفحة (P0)

**الوصف للمستخدم:** `Evaluate a JavaScript expression in the page and return a JSON-serialized result`.

**الـ Schema المقترح:**

```js
{
  expression: z.string().min(1).max(CONFIG.MAX_EVAL_LENGTH),
  await_promise: z.boolean().optional().default(true),
  user_gesture: z.boolean().optional().default(false),
  timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional().default(CONFIG.TOOL_DEFAULT_TIMEOUT_MS)
}
```

**البوابة الأمنية:**
- إن لم يكن `ENABLE_EVAL_JS` مفعّلاً (`1`/`true`/`yes`) → إرجاع `[EVAL_DISABLED]` فوراً **قبل** تشغيل المتصفح (لا استهلاك موارد).
- رسالة واضحة: `browser_evaluate is disabled. Set ENABLE_EVAL_JS=1 in the MCP server environment to enable it.`

**السلوك:**
1. `await ensureBrowserReady()` + انتظار `navigationPromise`.
2. `Runtime.evaluate({ expression, returnByValue: false, awaitPromise, userGesture, generatePreview: true })` مع `timeout_ms`.
3. التعامل مع النتيجة:
   - `exceptionDetails` موجود → `[EVAL_ERROR]` مع `exception.description` (سطر الخطأ). **لكن** الأخطاء الناتجة عن عدم قابلية التسلسل تُعالَج عبر الخطوة 4 لا كخطأ.
   - قيمة أولية (`type` = string/number/boolean) → تُستخدم مباشرة، ومع `unserializableValue` (مثل `NaN`, `Infinity`, `-0`, `BigInt`) تُحوَّل لنص وصفي.
   - `undefined` → `{ type: 'undefined', result: null }`.
   - كائن/دالة/DOM (`objectId` موجود) → استدعاء `Runtime.callFunctionOn` بدالة **ثابتة** `IN_PAGE.serializeValue` مع `{ maxDepth: 4, maxProps: 100 }`.
   - تحرير المقبض دائماً: `Runtime.releaseObject({ objectId })` في `finally`.
4. نتيجة التسلسل تُحوَّل إلى JSON وتُقصّ باستخدام `truncateText(..., CONFIG.MAX_EVAL_LENGTH)`.

**دالة التسلسل الثابتة `IN_PAGE.serializeValue`** (بدون `${` احتراماً لقاعدة الأمان) تتعامل مع: `undefined`, `bigint`, `symbol`, `function`, `Date`, `Error`, `Element` (tag/id/classes/text مختصر), `Array`, `Map`, `Set`, الكائنات الدائرية (`WeakSet`), والعمق/عدد الخصائص المحدود. أي شيء يتجاوز الحدود يُعلَّم `{ __type: 'truncated', ... }`.

**الناتج:** `{ result, type, truncated }` (وعند القصّ تكون `result` نصاً مقصوصاً).

**الأخطاء:** `EVAL_DISABLED`, `EVAL_ERROR` (استثناء داخل الصفحة), `TIMEOUT`.

**القفل:** نعم (JS عشوائي قد يعدّل الـ DOM).

**الأمان — مخاطر يجب توثيقها صراحةً في README والخطة:**
- يمكن للكود قراءة `document.cookie`, `localStorage`, ومحتوى الصفحة.
- يمكنه إجراء `fetch()` من داخل الصفحة إلى شبكات داخلية (`192.168.x`) متجاوزاً فحص `validateURL` المخصّص للتنقل فقط → **SSRF**. لذلك البوابة معطّلة افتراضياً، ويُنصح بعدم تفعيلها على صفحات غير موثوقة.
- لا يوجد قيد على طول/تعقيد التعبير سوى `MAX_EVAL_LENGTH` والمهلة.

---

### 4.3 `browser_hover` — تمرير المؤشر واختبار حالات hover (P1)

**الـ Schema المقترح:**

```js
{
  selector: z.string(),
  timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional().default(CONFIG.TOOL_DEFAULT_TIMEOUT_MS)
}
```

**السلوك (Runner جديد `hoverElement` في `helpers.js`):**
1. `waitForElement` → `isElementVisible` (وإلا `ELEMENT_HIDDEN`).
2. `scrollIntoView` (instant) ثم ~100ms + `waitForSettle` — نفس منطق `clickElement`.
3. `getClickablePoint` لتحديد نقطة غير محجوبة (center ثم الأرباع).
4. `Input.dispatchMouseEvent { type: 'mouseMoved', x, y }`.
5. للتوثيق/الموثوقية: إن لم يتحقّق `:hover` فوراً، أرسل حركة إلى إزاحة صغيرة ثم أعد الحركة إلى الهدف (بعض المحركات لا تُفعّل `:hover` عند القفز المباشر).
6. انتظار `waitForSettle`.
7. التحقق بـ `IN_PAGE.isHovered` (`this.matches(':hover')`).

**الناتج:** `{ hovered: true, selector, x, y, matchesHover }` — `matchesHover` مفيد للتشخيص (بعض العناصر لا تدعم `:hover` أصلاً، وهذه معلومة مفيدة لا خطأ).

**الأخطاء:** `ELEMENT_NOT_FOUND`, `ELEMENT_HIDDEN`.

**القفل:** نعم.

**ملاحظة للتقرير:** هذا يحلّ البند 3 (تعذّر التحقق من حالات hover) ويسمح بلقطة بعد hover تعكس الحالة الحقيقية.

---

### 4.4 `browser_press` — الضغط على مفاتيح لوحة المفاتيح (P1)

**الـ Schema المقترح:**

```js
{
  key: z.string().min(1),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional().default([]),
  selector: z.string().optional(),
  repeat: z.number().int().min(1).max(100).optional().default(1),
  timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional().default(CONFIG.TOOL_DEFAULT_TIMEOUT_MS)
}
```

**السلوك (Runner جديد `pressKey` في `helpers.js`):**
1. إن قُدّم `selector`: `waitForElement` → `isElementVisible` → `scrollIntoView` → `focusElement`.
2. `resolveKey(key, modifiers)` من `src/keymap.js`.
3. لكل تكرار:
   - زر نصّي (حرف/رقم/رمز): `keyDown` مع `text` = الحرف (يولّد `keypress`/`input`).
   - زر خاص (Enter/Escape/Tab/الأسهم...): `rawKeyDown` بلا `text`، ثم `keyUp`.
   - إرسال `keyUp` دائماً.
4. انتظار قصير + `waitForSettle` قبل العودة (لتفعيل `submit`/التنقل وحتى لا تكون اللقطة التالية فارغة).

**`src/keymap.js` (ملف جديد):**
- `MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }`.
- جدول `NAMED_KEYS` يحتوي على `{ key, code, keyCode, text }` للأزرار: `Enter(\r,13)`, `Tab(\t,9)`, `Escape`/`Esc(27)`, `Backspace(8)`, `Delete(46)`, `Insert(45)`, `ArrowUp/Down/Left/Right(38/40/37/39)`, `Home(36)`, `End(35)`, `PageUp(33)`, `PageDown(34)`, `Space(' ',32)`, `Shift(16)`, `Control(17)`, `Alt(18)`, `Meta(91)`, `CapsLock(20)`, `F1..F12(112..123)`.
- حرف/رقم/رمز واحد: يُحسب `code` (`KeyA`/`Digit1`)، و`keyCode` من `char.toUpperCase().charCodeAt(0)`.
- `resolveKey` يرفض غير المعروف بـ `KEY_NOT_SUPPORTED` مع قائمة الأزرار المدعومة.

**الناتج:** `{ pressed: true, key, modifiers, count, selector: selector ?? null, focused }`.

**الأخطاء:** `KEY_NOT_SUPPORTED`, `INVALID_ARGS`, `ELEMENT_NOT_FOUND`, `ELEMENT_HIDDEN`.

**القفل:** نعم.

**الأمان:** لا يُسجَّل في stderr إلا اسم المفتاح للأزرار المسمّاة؛ لو كان المفتاح حرفاً واحداً يُسجَّل `<char>` بدل القيمة (احتراماً لمنطق "لا تسجّل النص المُدخل").

**حالات استخدام مباشرة من التقرير:** الضغط على `Tab` للتنقل بين العناصر، `Escape` لإغلاق نافذة، و`Enter` داخل `#form-input` لإرسال النموذج (موجود فعلاً في الـ fixture).

---

## 5. إدارة حالة الـ viewport والتكامل مع `screenshot` (أخطر جزء)

### 5.1 التغييرات في `src/browser.js`

إضافة حقل `this.viewport = null` في الـ constructor، و3 دوال:

```js
async applyViewport({ width, height, deviceScaleFactor = 1, mobile = false }) {
  await this.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor, mobile
  });
  this.viewport = { width, height, deviceScaleFactor, mobile };
}

async clearViewport() {
  await this.send('Emulation.clearDeviceMetricsOverride');
  this.viewport = null;
}

async _reapplyViewport() {
  if (!this.viewport) return;
  try {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { ...this.viewport });
    process.stderr.write('[Browser] Re-applied viewport override\n');
  } catch (err) {
    process.stderr.write(`[Browser] Failed to re-apply viewport: ${err.message}\n`);
  }
}
```

- تُستدعى `_reapplyViewport()` في نهاية `_connectToPage()` بعد `_enableDomains()` — فتُغطّي: التشغيل الأول، إعادة الاتصال بعد WS-drop، وإعادة التشغيل بعد crash.
- `cleanup()` **لا** يمسح `this.viewport`، فيبقى الـ resize محفوظاً إذا أُغلق المتصفح بسبب الخمول ثم أُعيد تشغيله.

### 5.2 التعديل الحرج في `index.js` داخل `browser_screenshot`

الوضع الكامل حالياً يضبط override ثم يمسحه. التعديل:

```js
const previousViewport = browser.viewport; // احتفظ بحالة resize
let emulationSet = false;
try {
  if (full_page) {
    /* ... existing full-page override ... */
    emulationSet = true;
  }
  /* custody/capture ... */
} finally {
  if (emulationSet) {
    if (previousViewport) {
      await browser.applyViewport(previousViewport).catch(() => {});
    } else {
      await browser.send('Emulation.clearDeviceMetricsOverride', {}, 5000).catch(() => {});
    }
  }
}
```

> **بالضبط في الكتلة `finally` الحالية (سطر `if (emulationSet)`) التي تستدعي `clearDeviceMetricsOverride`.**

> **إضافة مطلوبة في نفس دالة `browser_screenshot`:** كتلة حدّ البكسل الحالية تنفّذ `clip.scale` بينما `clip` **غير معرّف** في مسار الـ viewport (انهيار مؤكَّد عند resize كبير). الحل المُثبَّت في §13.1: تصغير viewport عبر `clip` + `captureBeyondViewport:true` + احتساب `deviceScaleFactor`.

### 5.3 اعتبارات
- اللقطة الكاملة مع `mobile:true` قد تُنتج مقاساً مختلفاً؛ سنثبّت `mobile:false` وقت الالتقاط ثم نستعيد الحالة — موثّق.
- `browser_resize` مع `reset` يعيد المتصفح للمقاس الافتراضي (`800x600` تقريباً) الموثّق في التقرير.

---

## 6. التغييرات ملف بملف (خريطة العمل)

| الملف | نوع التغيير | التفاصيل |
|---|---|---|
| `src/viewport.js` | **جديد** | `VIEWPORT_PRESETS` + `resolveViewportParams(args)` (تحقق + دمج) + ثوابت الحدود |
| `src/keymap.js` | **جديد** | `MODIFIER_BITS`, `NAMED_KEYS`, `resolveKey()` |
| `src/helpers.js` | تعديل | إضافة `IN_PAGE.isHovered` و`IN_PAGE.serializeValue`؛ و Runners: `hoverElement`, `pressKey`, `evaluateExpression`, وربما `serializeRemoteObject` |
| `src/browser.js` | تعديل | `viewport` state + `applyViewport`/`clearViewport`/`_reapplyViewport` + استدعاء في `_connectToPage` |
| `src/utils.js` | تعديل | `isEvalJsEnabled()` + `MAX_EVAL_LENGTH` في `CONFIG` + أكواد أخطاء جديدة في `ERRORS` |
| `index.js` | تعديل | تسجيل الأدوات الأربع + استيراد الدوال الجديدة + تعديل `finally` في `browser_screenshot` |
| `fixtures/test-page.html` | تعديل | عناصر hover + مستقبل مفاتيح في **نهاية** `<body>` |
| `tests/keymap.test.js` | **جديد** | اختبارات وحدة لجدول المفاتيح والتحقق |
| `tests/viewport.test.js` | **جديد** | اختبارات وحدة لدمج/تحقق الـ presets |
| `tests/resize.test.js` | **جديد** | تكامل: المقاس، الـ presets، reset، البقاء بعد navigation، عدم المسح بعد full_page |
| `tests/evaluate.test.js` | **جديد** | تكامل: البوابة معطلة/مفعّلة، primitives، DOM، circular، promise، exception، truncation |
| `tests/hover-press.test.js` | **جديد** | تكامل: hover + press (Enter/Tab/Escape/modifiers) |
| `tests/helpers.test.js` | تعديل | إضافة أسماء الـ helpers الجديدة + التأكد من عدم وجود `${` |
| `.env.example` | تعديل | `ENABLE_EVAL_JS` يصبح منفّذاً + `MAX_EVAL_LENGTH` |
| `README.md` | تعديل | 9→13 أداة، جداول ومراجع، أمان، أخطاء، بنية |
| `ARCHITECTURE.md` | تعديل | الأدوات، الـ helpers، الـ env، خريطة الاعتماديات |
| `AGENTS.md` | تعديل | قائمة الأدوات + السلوكيات |

---

## 7. الأمان

- **`browser_evaluate`**: معطّلة افتراضياً (`ENABLE_EVAL_JS`)، ورسالة خطأ واضحة. توثيق صريح لمخاطر SSRF/قراءة بيانات الصفحة. لا تُنفَّذ أبداً إذا كانت البوابة مغلقة.
- **`browser_resize`**: حدود مقاس و`deviceScaleFactor` تمنع Abuse.
- **`browser_hover` / `browser_press`**: لا مدخلات تُدمج في الكود؛ الإحداثيات والأزرار تُحسب داخلياً. لا يُسجَّل نص حرفي للأزرار الفردية.
- **القاعدة الذهبية محفوظة**: أي دالة جديدة في `IN_PAGE` نص ثابت بلا `${`، والمدخلات تمرّ عبر CDP `arguments`.
- **`Runtime.evaluate` غير المباشر** في `browser_get_text` يبقى كما هو (لا يتغير سطح الأمان الحالي).

---

## 8. خطة الاختبارات

### 8.1 وحدة (بدون Chromium — سريعة)
- `tests/keymap.test.js`: الأزرار المسمّاة، الأحرف، الرموز، المفاتيح غير المدعومة → `KEY_NOT_SUPPORTED`، حساب bitmask للمُعدِّلات.
- `tests/viewport.test.js`: كل تركيبات `preset`/`width+height`/`reset`، الرفض عند التركيب/النقص.
- توسعة `tests/helpers.test.js`: ضمان أن `serializeValue` و`isHovered` نصوص دوال ثابتة بلا `${`.
- توسعة `tests/utils.test.js`: `isEvalJsEnabled()` و`MAX_EVAL_LENGTH`.

### 8.2 تكامل (Chromium حقيقي، نمط الملفات الحالية)
- `tests/resize.test.js`:
  - resize إلى `500x700` ثم `evaluate` يقرأ `window.innerWidth/innerHeight` (مع `ENABLE_EVAL_JS=1`).
  - كل preset يضبط القيم الصحيحة.
  - `reset` يعيد القيم الافتراضية.
  - الـ resize **يبقى** بعد `browser_navigate`.
  - **اختبار انحدار حرج**: resize → `screenshot full_page` → evaluate → `innerWidth` لم يتغير.
- `tests/evaluate.test.js`:
  - بدون البوابة → `[EVAL_DISABLED]` (مع spawn بلا env).
  - primitives، كائن، مصفوفة، `document.querySelectorAll(...).length`.
  - `await_promise: true` مع Promise.
  - نتيجة غير قابلة للتسلسل (دالة/DOM) تُعاد كتمثيل وصفي لا كخطأ.
  - استثناء داخل الصفحة → `[EVAL_ERROR]` مع وصف.
  - قصّ الناتج عند تجاوز `MAX_EVAL_LENGTH`.
- `tests/hover-press.test.js`:
  - hover على `#hover-target` يجعل `matchesHover` صحيحاً ويُظهر `#hover-result`.
  - `Enter` داخل `#form-input` (بعد focus) يرسل النموذج ويحدّث `#click-result`.
  - `Tab` ينقل التركيز (نتحقق عبر `document.activeElement.id` بواسطة evaluate).
  - `Escape` يُحدّث `#key-result` عبر مستمع keydown.
  - `modifiers: ['Control']` + `a` يعمل.
  - `key` غير مدعوم → `[KEY_NOT_SUPPORTED]`.

### 8.3 إضافات الـ fixture (نهاية `<body>` — لا تكسر "أول زر")
- `#hover-target` + `#hover-result` مع CSS `:hover` ومستمع `mouseenter`.
- `#key-result` مع مستمع `keydown` على `document` يسجّل `e.key` + `e.ctrlKey`...إلخ.
- (اختياري) `#press-form` لإرسال Enter — لكن `#interaction-form` الحالي يكفي.

### 8.4 التحقق النهائي
- `npm test` كامل أخضر مع Chromium.
- عدم تجاوز زمن مقبول وعدم ترك عمليات Chromium (يمكن تشغيل `./stress-test.sh` اختياريًا).
- التأكد أن اختبارات القائمة/العدّ الحالية لم تتأثر.

---

## 9. خطة التوثيق (تبقى متزامنة مع الكود)

- **`README.md`** (⚠️ يجب تفعيل مهارة `readme-master` قبل أي تعديل عليه — قاعدة موثّقة في `AGENTS.md`):
  - "nine tools" → "thirteen tools" في كل المواضع، وقائمة الأدوات في `What It Does` و`Architecture`.
  - إضافة الأدوات الأربع إلى `Quick Reference` وجداول المعاملات الكاملة.
  - تحديث `Error codes` بالأكواد الجديدة.
  - تحديث `Security` ببوابة `ENABLE_EVAL_JS` ومخاطرها.
  - تحديث `Configuration` (ENABLE_EVAL_JS منفّذ + MAX_EVAL_LENGTH).
  - تحديث `Project Structure` (`src/viewport.js`, `src/keymap.js`, ملفات الاختبار الجديدة) وعدّاد الشارة إن تغيّر.
- **`ARCHITECTURE.md`**: 9→13، قسم لكل أداة، `IN_PAGE` الجديدة، `Browser.viewport`، جدول env، خريطة الاعتماديات.
- **`AGENTS.md`**: قائمة الأدوات + bullets السلوك للأدوات الجديدة.
- **`.env.example`**: إزالة صفة "RESERVED" عن `ENABLE_EVAL_JS`، وإضافة `MAX_EVAL_LENGTH` مع النوع/الافتراضي/المدى.

---

## 10. المراحل والتنفيذ

**المرحلة 0 — تحضير بلا تغيير سلوك**
- إضافة `src/viewport.js` و`src/keymap.js` + اختبارات الوحدة.
- إضافة أسماء الـ helpers الجديدة إلى `tests/helpers.test.js`.

**المرحلة 1 — البنية التحتية**
- `src/utils.js`: `isEvalJsEnabled`, `MAX_EVAL_LENGTH`, أكواد الأخطاء.
- `src/helpers.js`: `IN_PAGE.isHovered`, `IN_PAGE.serializeValue`, والـ Runners الثلاثة.
- `src/browser.js`: حالة الـ viewport + `_reapplyViewport` في `_connectToPage`.

**المرحلة 2 — تسجيل الأدوات**
- `index.js`: الأدوات الأربع + إصلاح `finally` في `browser_screenshot`.

**المرحلة 3 — الاختبارات**
- إضافات الـ fixture + ملفات التكامل الثلاثة. تشغيل `npm test`.

**المرحلة 4 — التوثيق**
- `README.md` (بعد `readme-master`), `ARCHITECTURE.md`, `AGENTS.md`, `.env.example`.

**المرحلة 5 — التحقق النهائي**
- `npm test` كامل + مراجعة عدم وجود عمليات متبقّية + مراجعة يدوية للسلوك عبر الأداة الحقيقية.

**خارج النطاق (مقترحات لاحقة من التقرير):** سجل الشبكة (`browser_get_network`)، `wait_until`/انتظار الخطوط، تجميع الإجراءات، توضيح إحداثيات `click` بعد التمرير التلقائي، و`browser_get_attributes` (مغطّى جزئياً بـ `browser_evaluate`).

---

## 11. المخاطر وخطط التخفيف

| المخاطرة | الاحتمال | الأثر | التخفيف |
|---|---|---|---|
| مسح الـ resize بعد لقطة كاملة | مؤكد إن لم نعدّل | مرتفع | استعادة `previousViewport` في `finally` |
| فقدان الـ viewport بعد crash/reconnect | متوسط | مرتفع | `_reapplyViewport()` في `_connectToPage` |
| مخاطر أمنية لـ evaluate (SSRF/بيانات) | مرتفع إن فُعّلت | مرتفع | بوابة معطّلة افتراضياً + توثيق صريح |
| عدم موثوقية `:hover` في headless | منخفض/متوسط | متوسط | إعادة حركة بإزاحة + إرجاع `matchesHover` |
| اختلاف خصائص أزرار المفاتيح بين إصدارات Chromium | منخفض | متوسط | تمرير `key`+`code`+`keyCode`+`text` + اختبارات |
| كسر اختبار "أول زر" | متوسط | منخفض | إضافة عناصر الـ fixture في نهاية `<body>` فقط |
| ازدحام القفل بسبب إقفال evaluate | منخفض | منخفض | توثيق السلوك؛ يمكن لاحقاً فتح خيار `read_only` غير مقفول |
| تعارض `mobile:true` مع full_page | منخفض | منخفض | تثبيت `mobile:false` وقت الالتقاط ثم الاستعادة |

> **تحديث 2026-09-14:** العطلان الحرجان (مسح resize بعد `full_page`، وفقدان viewport بعد crash/reconnect) جرى حلّهما والتحقق منهما عملياً — انظر §13. كما صُحّح فهم «فقدان viewport عند إعادة الاتصال»: القياس يُثبت بقاء الـ override بعد إعادة اتصال WebSocket، ويُفقد فقط عند إعادة تشغيل العملية بعد crash.

**خطة التراجع:** كل التغييرات في ملفات إضافية جديدة أو تعديلات معزولة؛ التراجع عبر `git checkout -- <file>` لكل ملف، وحذف الملفات الجديدة. لا تغييرات هيكلية أو migrations.

---

## 12. معايير القبول (Definition of Done)

- [ ] الأدوات الأربع مسجّلة وتظهر في `tools/list` مع schemas صحيحة.
- [ ] `browser_resize` يعمل (preset/explicit/reset) ويبقى بعد navigation ولا يُمحى بـ `full_page`.
- [ ] `browser_evaluate` معطّل افتراضياً، ويعمل بالكامل عند `ENABLE_EVAL_JS=1`.
- [ ] `browser_hover` يُفعّل الحالة و`browser_press` ينفّذ Enter/Tab/Escape/الأسهم والمُعدِّلات.
- [ ] قاعدة عدم دمج المدخلات في الكود محفوظة (اختبار `helpers.test.js` أخضر).
- [ ] `npm test` كامل أخضر، ولا عمليات Chromium متبقية.
- [ ] `README.md` + `ARCHITECTURE.md` + `AGENTS.md` + `.env.example` محدّثة ومتزامنة مع الكود.
- [ ] لا تعديل على `src/cdp.js` ولا على منطق ارتباط الطلبات.

---

## 13. تحديث (2026-09-14): الحلول المؤكَّدة للعطلين الحرجين P0

> طُبِّقت هذه الحلول واختُبرت في **بيئة sandbox معزولة** (نسخة من المشروع) دون أي تعديل على كود المشروع. التفاصيل الكاملة والأدلة في [`docs/reports/solutions.md`](../reports/solutions.md).

### 13.1 حل P0-1 — الانهيار في `browser_screenshot` بعد `resize`

**السبب:** في مسار اللقطة الجزئية لا يُبنى `clip` (يُترك `undefined`)، لكن كتلة الحد تنفّذ `clip.scale = …` → `TypeError`. تُفعَّل عند مقاس > `MAX_SCREENSHOT_PIXELS` (وحدود `resize` تسمح بـ `10000×10000 = 100MP`).

**الحل (مُثبَّت عملياً):** استبدال حساب البكسل بمنطق يفرّق بين المسارين ويحتسب `deviceScaleFactor`:

```js
const captureDsf = (!clip && browser.viewport && browser.viewport.deviceScaleFactor) || 1;
const baseSize = clip ?? captureSize;
const totalPixels = baseSize.width * baseSize.height * captureDsf * captureDsf;
if (totalPixels > MAX_SCREENSHOT_PIXELS) {
  const scaleFactor = Math.sqrt(MAX_SCREENSHOT_PIXELS / totalPixels);
  if (clip) {
    clip.scale = scaleFactor;                 // full_page — كما كان
  } else {
    // viewport: clip على مستطيل العرض الحالي + captureBeyondViewport:true
    const v = metrics.cssVisualViewport || metrics.visualViewport || metrics.layoutViewport;
    clip = { x: v.pageX || 0, y: v.pageY || 0,
             width: v.clientWidth, height: v.clientHeight, scale: scaleFactor };
    captureBeyondViewport = true;
  }
  truncated = true;
}
```

كما تبقى حماية §5.2 (استعادة `previousViewport` في `finally`) لازمة حتى لا تُلغي لقطة `full_page` أي resize سابق.

**الدليل:** قبل الإصلاح `resize 5000×5000 → screenshot` أعاد `Cannot set properties of undefined (setting 'scale')`؛ بعده أعاد `isError=false` مع `truncated=true` وصورة `≈4000×4000`. واختبارات التكامل (12/12) تشمل: التصغير ضمن الحد، dSF=3، البقاء بعد navigation، والبقاء بعد `full_page`.

### 13.2 حل P0-2 — `Zod` مع `reset`

**السبب:** `.default()` على حقول المخطط يجعل القيم الافتراضية تصل إلى المعالج دائماً، فيُرفض `reset` أبداً ويستحيل اكتشاف `{}`.

**الحل (مُثبَّت عملياً):** إزالة `.default()` من المخطط، ونقل التحقق إلى `resolveViewportParams(args)` على المدخل الخام:

- `reset` وحدها → `{ mode:'reset' }`؛ `reset` مع أي خيار → `INVALID_ARGS`.
- `preset` وحدها (مع تجاوز اختياري لـ `device_scale_factor`/`mobile`)؛ `preset` مع `width`/`height` → `INVALID_ARGS`.
- `width`+`height` → تطبيق مباشر؛ أحدهما دون الآخر → `INVALID_ARGS`.
- لا شيء أو `reset:false` وحدها → `INVALID_ARGS`.

**الدليل:** 12/12 اختبار وحدة + 6/6 اختبار تكامل (منها `{}` و`{reset:true}` و`{reset:true,width,height}`).

### 13.3 نتائج الانحدار

أُعيد تشغيل مجموعة اختبارات المشروع على الكود المُرقَّع تسلسلياً (تزامن 1): **173/173 نجحت، 0 فشل** (بما فيها اختبار «reset emulation after full_page screenshot»). تُرك `memory.test.js` (7 اختبارات، 50 دورة) دون تشغيل احترازياً لضغط الذاكرة، وهو غير متأثر بالتعديل.

### 13.4 اكتشافات إضافية يجب مراعاتها عند التنفيذ

- **`deviceScaleFactor` يضاعف دقّة اللقطة:** أُضيف `dSF²` إلى حساب البكسل. (`500×700 @3 → 1500×2100`.)
- **`Emulation.scale` لا يُصغّر اللقطات** — الصقل الصحيح عبر `clip.scale` فقط.
- **override الخاص بـ Emulation يبقى بعد إعادة اتصال WebSocket** (تحقّقنا عملياً)؛ لذا `_reapplyViewport` مطلوب فعلياً لإعادة التشغيل بعد crash، وزائد (غير ضار) على الـ reconnect.
- **المقاس الافتراضي الفعلي `780×437`** لا `800×600`.
- **ملاحظة متبقّية:** `mobile:true` يُضيف page-scale فتصبح اللقطة أكبر من تقدير `w×h×dSF²` (preset الجوال ≈ `16MP` فعلياً). الحل الكامل في **§14**.

---

## 14. معالجة `mobile:true` + viewport كبير + `screenshot` (التحقق بعد الالتقاط وإعادة التصغير)

> هذا القسم يعالج الحالة التي يفشل فيها التقدير المسبق للبكسل: **`mobile:true` مع viewport كبير**. المبدأ: **لا نثق بالحساب النظري وحده**؛ المرجع النهائي هو **قياس الصورة الفعلية بعد الالتقاط**، ثم إعادة التصغير عند التجاوز.

### 14.1 المشكلة بدقّة

- `mobile:true` يُفعّل **page-scale** في Chromium (تحجيم viewport الجوّال)، فيصبح عدد بكسلات الصورة الفعلية أكبر من `width × height × deviceScaleFactor²`.
- قياس فعلي: preset الجوال (`390×844`, `dSF=3`, `mobile:true`) ينتج صورة **`2719×5882 ≈ 15.99MP`**، بينما التقدير `390×844×9 = 2.96MP` فقط (فرق ≈ 5.4×).
- كذلك `MAX_IMAGE_BYTES` **غير مطبَّق** حالياً على اللقطات إطلاقاً، فإن تجاوزت الصورة حدّ البايتات لا يوجد ما يمنعها.
- الأثر العملي: قد تتجاوز اللقطة `MAX_SCREENSHOT_PIXELS` بصمت، وقد تُنتج payload ضخماً يستهلك الذاكرة ونقل stdio.

### 14.2 المبدأ: مصدران للحقيقة

نعتمد **طبقتين متكاملتين**:

1. **طبقة تقدير مسبق (best-effort):** تقرأ `visualViewport.scale` وتستخدمه لتقليل احتمال الحاجة إلى التقاط ثانٍ.
2. **طبقة تحقق بعد الالتقاط (المرجع الموثوق):** تفكّ ترميز أبعاد الصورة الحقيقية وتقيس `buffer.length`؛ وإن تجاوزت الحدود تُعيد التصغير بـ `clip.scale` ثم تُعيد الالتقاط (بمحاولات محدودة).

> الطبقة (2) وحدها كافية لضمان عدم تجاوز الحد؛ والطبقة (1) تحسين للأداء فقط (تجنّب لقطة ثانية في الحالات الشائعة).

### 14.3 الطبقة 1 — تقدير مسبق عبر `visualViewport.scale`

من `Page.getLayoutMetrics` نحصل على `cssVisualViewport` التي تحوي: `clientWidth`, `clientHeight`, `pageX`, `pageY`, **`scale`** (page-scale)، إضافةً إلى `deviceScaleFactor` المخزّن في `browser.viewport`.

التقدير التقريبي (مع هامش أمان):

```
effectiveScale  ≈ deviceScaleFactor / max(visualViewport.scale, ε)   // page-scale يقلّص viewport المنطقي
estPixels       ≈ cssWidth × cssHeight × effectiveScale²
```

- إن كان `estPixels > MAX_SCREENSHOT_PIXELS` → نبدأ مباشرةً بـ `clip.scale = sqrt(MAX_SCREENSHOT_PIXELS / estPixels) * 0.98`.
- نستخدم هامش `0.98` لأن التقدير **تقريبي**؛ والمرجع يبقى الطبقة (2).
- إن كان التقدير ≤ الحد → نلتقط بلا تصغير (المسار السريع الحالي).

> هذه الطبقة **اختيارية**: يمكن حذفها والاعتماد كلياً على الطبقة (2) مقابل تكلفة لقطة ثانية عند التجاوز.

### 14.4 الطبقة 2 — التحقق بعد الالتقاط (الجوهر)

بعد كل التقاط، وقبل إرجاع النتيجة:

1. **الأبعاد الحقيقية:** فكّ ترميز رأس الصورة من الـ `Buffer` (انظر §14.5).
2. **حجم البايتات:** `buffer.length`.
3. الحكم:
   - `overPixels = width × height > MAX_SCREENSHOT_PIXELS`
   - `overBytes  = buffer.length > MAX_IMAGE_BYTES`
4. إن لم يتجاوز أياً منهما → أعِد النتيجة (`truncated` حسب هل حدث تصغير أم لا).
5. إن تجاوز → احسب معامل تصحيح وأعِد الالتقاط (انظر §14.6)، بحدّ أقصى للمحاولات.

### 14.5 قراءة الأبعاد الحقيقية من الصورة (بلا مكتبات خارجية)

- **PNG:** العرض/الارتفاع في مقطع `IHDR` عند الإزاحات `16` و`20` (Big-Endian):
  ```js
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  ```
- **JPEG:** امسح العلامات بحثاً عن `SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15` (نطاق `0xFFC0–0xFFCF` باستثناء `0xC4` و`0xC8` و`0xCC`)، ثم اقرأ `height` (2 بايت) فـ `width` (2 بايت).
- إن فشل التحليل لأي سبب → أعِد `null` واعتبر التقدير المسبق (§14.3) بديلاً، مع وسم النتيجة `measured: false` للتشخيص.

> الصيغتان المدعومتان هما `png` و`jpeg` فقط، لذا لا حاجة لدعم WebP.

### 14.6 معادلة إعادة التصغير وإعادة الالتقاط

```
fPix  = overPixels ? sqrt(MAX_SCREENSHOT_PIXELS / (width × height)) : 1
fByte = overBytes  ? sqrt(MAX_IMAGE_BYTES / buffer.length)          : 1
f     = min(fPix, fByte) × 0.98          // هامش أمان
newScale = (currentScale ?? 1) × f       // currentScale = 1 للمسار بلا clip
```

ثم:

- **إن كان الالتقاط مكتنفاً بـ `full_page` (يوجد `clip` مسبقاً):** عدّل `clip.scale = newScale` وأعِد الالتقاط بنفس `clip` و`captureBeyondViewport:true`.
- **إن كان التقاط viewport بلا `clip`:** ابنِ `clip` لمستطيل العرض الحالي (كما في §13.1):
  ```js
  const v = metrics.cssVisualViewport || metrics.visualViewport || metrics.layoutViewport;
  clip = { x: v.pageX || 0, y: v.pageY || 0,
           width: v.clientWidth, height: v.clientHeight, scale: newScale };
  captureBeyondViewport = true;            // يمنع الإطار الفارغ على الصفحات المُمرَّرة
  ```
- الأبعاد الناتجة = `clip.width × clip.scale × deviceScaleFactor` (مُتحقَّق منها عملياً).

### 14.7 الخوارزمية الكاملة (pseudo-code)

```js
const MAX_CAPTURE_ATTEMPTS = 2;   // لقطة أولى + تصحيح واحد

async function captureWithinLimits({ format, quality, full_page }) {
  let clipScale = estimateInitialScale();     // §14.3 (قد تكون 1)
  let result;

  for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt++) {
    result = await doCapture({ format, quality, full_page, clipScale }); // يبني clip كما في §14.6
    const dims  = decodeImageSize(result.buffer, format);                // §14.5
    const bytes = result.buffer.length;

    const overPixels = dims && dims.width * dims.height > MAX_SCREENSHOT_PIXELS;
    const overBytes  = bytes > MAX_IMAGE_BYTES;
    if (!overPixels && !overBytes) {
      return { ...result, dims, bytes, truncated: attempt > 0, measured: !!dims };
    }

    clipScale = computeNewScale(clipScale, dims, bytes);   // §14.6
    process.stderr.write(`[MCP] Screenshot over limit (px=${dims?.width}x${dims?.height}, bytes=${bytes}); re-capturing scale=${clipScale.toFixed(3)}\n`);
  }

  // لا يزال متجاوزاً بعد المحاولات → خطأ صريح
  return formatToolError(toolError(
    'SCREENSHOT_TOO_LARGE',
    `Screenshot still exceeds limits after ${MAX_CAPTURE_ATTEMPTS} attempts ` +
    `(px=${lastDims?.width}x${lastDims?.height}, bytes=${lastBytes}). ` +
    `Use a smaller viewport or lower quality.`
  ));
}
```

### 14.8 الناتج والقياسات التشخيصية

يصبح ناتج `browser_screenshot` أغنى:

```json
{ "path": "...", "size": 123456, "truncated": true,
  "width": 4000, "height": 4000, "scale": 0.632, "measured": true }
```

- `width`/`height`: الأبعاد **الحقيقية** بعد أي تصغير (مفيدة للعميل).
- `truncated: true`: يعني «جرى تصغير لتلبية الحد» (ليس قصّاً — لا نقصّ الصورة أبداً).
- `scale`: معامل التصغير المطبَّق.
- `measured`: هل تمكّنّا من قراءة الأبعاد (تشخيص فقط).

### 14.9 التفاعل مع بقية الميزات

- **`full_page`:** نفس الحلقة تنطبق؛ الـ `clip` موجود مسبقاً فيكفي تعديل `scale`. يبقى التصغير «تصغير دقة» وليس قصّاً.
- **`jpeg` + `quality`:** التصغير يقلّل البايتات تناسبياً تقريباً مع `scale²`. يمكن (اختيارياً) خفض `quality` كخطوة أخيرة إن تعذّر الوصول للحد بالتصغير وحده، مع توثيقه.
- **`deviceScaleFactor` كبير:** مغطّى تلقائياً لأن الحساب الفعلي يشمل الأثر الحقيقي.
- **`MAX_IMAGE_BYTES`:** يصبح مُطبَّقاً فعلياً لأول مرة على اللقطات.
- **لا تستخدم `truncateBuffer` للصور:** قصّ base64 يُفسد الصورة؛ التصغير هو الوسيلة الصحيحة.

### 14.10 المخاطر والاعتبارات

| المخاطرة | التخفيف |
|---|---|
| لقطة ثانية تزيد الزمن | تحدث **فقط** عند التجاوز، وبحد أقصى محاولة تصحيح واحدة؛ الأوضاع الشائعة (desktop/explicit) لا تتجاوز. |
| إعادة التقاط لا تصل للحد | خطأ `SCREENSHOT_TOO_LARGE` واضح بدل صورة ضخمة أو انهيار. |
| تضخّم mobile preset (≈16MP) | سيتجاوز الحد بحدّة فيُصحَّح تلقائياً في المحاولة الثانية. |
| فشل قراءة الأبعاد (JPEG نادراً) | `measured:false` + الاعتماد على التقدير المسبق، مع بقاء فحص البايتات فعّالاً. |
| تكرار لا نهائي | `MAX_CAPTURE_ATTEMPTS` ثابت. |

### 14.11 معايير القبول والاختبارات لهذا القسم

- [ ] لقطة `mobile` preset: الأبعاد الحقيقية ≤ `MAX_SCREENSHOT_PIXELS` والبايتات ≤ `MAX_IMAGE_BYTES`، و`truncated:true`.
- [ ] لقطة `{width:5000,height:5000}`: نفس الضمان، بلا انهيار.
- [ ] كلاهما بصيغتي `png` و`jpeg`.
- [ ] لقطة `full_page` لصفحة عملاقة: تُصغَّر (لا تُقصّ)، وحدودها محسوبة.
- [ ] عند استحالة الوصول للحد → `[SCREENSHOT_TOO_LARGE]` برسالة واضحة (لا صورة فاسدة).
- [ ] التأكد أن الأبعاد المُعادة (`width`/`height`) مساوية للأبعاد المفكوكة فعلياً من البايتات.
- [ ] القياسات تجري من **الـ Buffer** (لا من base64) لتقليل التكلفة.
