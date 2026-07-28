/**
 * Checked-in distillations of a live Ashby application form (TRM careers,
 * captured 2026-07-28 via Playwright DOM dump). One export per pattern the scan
 * must survive. Class names deliberately keep the CSS-module hash shape
 * (`_required_f7cvd_91`) because the required/description class-token rules
 * must match hashed tokens. PROJECT-OWNED copy — edit freely.
 *
 * jsdom computes no layout: tests drive hidden/clipped states through an
 * injected MeasureFn, never through CSS in these strings.
 */

/** Dangling label (`for` resolves to no id) + combobox that would otherwise
 *  fall through to placeholder "Start typing...". Label carries the Ashby
 *  required class token. */
export const ASHBY_COMBOBOX = `
<fieldset class="_container_wz442_28 _fieldEntry_1e3gg_28">
  <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42 ashby-application-form-question-title" for="614055f0-a5e7-4d24-b18f-00f41f3e6fab">Select your country of employment</label>
  <div class="_inputContainer_d7ago_28">
    <input class="_input_d7ago_28" placeholder="Start typing..." aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" role="combobox" value="">
    <button class="_container_pjyt6_1 _toggleButton_d7ago_32"></button>
  </div>
</fieldset>`

/** Combobox whose description block is the CONTROL'S UNCLE (sibling of the
 *  control's container, child of the wrapper). Contains an href that must be
 *  discarded by textContent capture. */
export const ASHBY_COMBOBOX_WITH_DESCRIPTION = `
<fieldset class="_container_wz442_28 _fieldEntry_1e3gg_28">
  <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42" for="cb-desc-uuid-1">Please select your current job level</label>
  <div class="_description_1e3gg_48 ashby-application-form-question-description"><p>If unsure, choose the option that most closely matches your <a href="https://example.com/levels">experience</a>.</p></div>
  <div class="_inputContainer_d7ago_28">
    <input class="_input_d7ago_28" placeholder="Start typing..." aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" role="combobox" value="">
    <button class="_container_pjyt6_1 _toggleButton_d7ago_32"></button>
  </div>
</fieldset>`

/** Yes/No question: two untyped buttons + a hidden checkbox whose NAME equals
 *  the dangling label's `for` (the name==for convention). */
export const ASHBY_YESNO_EN = `
<div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
  <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42 ashby-application-form-question-title" for="f1787b93-cd38-40ed-a0ff-357056af73f2">Are you legally authorized to work in your current country of employment?</label>
  <div class="_container_1svni_28 _yesno_1e3gg_148">
    <button class="_container_pjyt6_1 _option_1svni_32">Yes</button>
    <button class="_container_pjyt6_1 _option_1svni_32">No</button>
    <input type="checkbox" class="_input_1svni_78" tabindex="-1" name="f1787b93-cd38-40ed-a0ff-357056af73f2">
  </div>
</div>`

/** i18n variant: option texts are NOT boolean words. Options must be captured
 *  verbatim ("Sim"/"Não"), never boolean-mapped. */
export const ASHBY_YESNO_PT = `
<div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
  <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42" for="pt-uuid-0001">Você precisa de patrocínio de visto?</label>
  <div class="_container_1svni_28 _yesno_1e3gg_148">
    <button class="_container_pjyt6_1 _option_1svni_32">Sim</button>
    <button class="_container_pjyt6_1 _option_1svni_32">Não</button>
    <input type="checkbox" class="_input_1svni_78" tabindex="-1" name="pt-uuid-0001">
  </div>
</div>`

/** Radio-backed choice: same segmented-buttons pattern but the hidden inputs
 *  are RADIOS sharing a name. Must enumerate as ONE `choice` field. */
export const ASHBY_CHOICE_RADIO = `
<div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
  <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42" for="rc-uuid-0001">Do you consent to a background check?</label>
  <div class="_container_1svni_28 _yesno_1e3gg_148">
    <button class="_container_pjyt6_1 _option_1svni_32">Yes</button>
    <button class="_container_pjyt6_1 _option_1svni_32">No</button>
    <input type="radio" class="_input_1svni_78" tabindex="-1" name="rc-uuid-0001" value="yes">
    <input type="radio" class="_input_1svni_78" tabindex="-1" name="rc-uuid-0001" value="no">
  </div>
</div>`

/** Radio fieldset with a CHILD <label> (no <legend>): the group label is the
 *  dangling question label, never an option's text. Radio ids RESOLVE their
 *  option labels' `for` — option labels are structurally not dangling. */
export const ASHBY_RADIO_FIELDSET = `
<fieldset class="_container_1258i_28 _fieldEntry_1e3gg_28">
  <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42 ashby-application-form-question-title" for="68fd0781-2a61-4f31-a4c5-aa8d808d4afb">Have you previously worked in a remote or hybrid environment?</label>
  <div class="_option_1258i_34"><span class="_container_132c8_28"><span class="_circle_132c8_77"></span><input type="radio" id="rg1-radio-0" name="rg1-68fd0781"></span><label for="rg1-radio-0" class="_label_1258i_42">Yes, fully remote</label></div>
  <div class="_option_1258i_34"><span class="_container_132c8_28"><span class="_circle_132c8_77"></span><input type="radio" id="rg1-radio-1" name="rg1-68fd0781"></span><label for="rg1-radio-1" class="_label_1258i_42">Yes, hybrid</label></div>
  <div class="_option_1258i_34"><span class="_container_132c8_28"><span class="_circle_132c8_77"></span><input type="radio" id="rg1-radio-2" name="rg1-68fd0781"></span><label for="rg1-radio-2" class="_label_1258i_42">No</label></div>
</fieldset>`

/** Single-option consent: ONE radio, group label = the policy statement
 *  (dangling), option label = "I agree". */
export const ASHBY_CONSENT_SINGLE = `
<fieldset class="_container_1258i_28 _fieldEntry_1e3gg_28">
  <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42" for="b8b84bc4-a847-41c7-b1b0-8b4b7df06d19">By submitting your application, you are agreeing not to use AI interview tools during the interview process.</label>
  <div class="_option_1258i_34"><span class="_container_132c8_28"><span class="_circle_132c8_77"></span><input type="radio" id="cs1-radio-0" name="cs1-b8b84bc4"></span><label for="cs1-radio-0" class="_label_1258i_42">I agree</label></div>
</fieldset>`

/** Essay with a description block as the CONTROL'S SIBLING. The label RESOLVES
 *  (id present) — description capture must work for resolvable bindings too. */
export const ASHBY_ESSAY_WITH_DESCRIPTION = `
<div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
  <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42" for="a9b7a69d-09f8-4523-a8e5-da595658abb4">Describe the fastest measurable outcome you delivered in the past 12 months.</label>
  <div class="_description_1e3gg_48 ashby-application-form-question-description"><p><strong>Please include: </strong><br>• What made it challenging? <br>• The total timeline from start to finish</p></div>
  <textarea placeholder="Type here..." required="" name="a9b7a69d-09f8-4523-a8e5-da595658abb4" id="a9b7a69d-09f8-4523-a8e5-da595658abb4" class="_input_zf0lr_28 _input_1e3gg_32" rows="4"></textarea>
</div>`

/** EEO yes/no in a PLAIN DIV (no fieldset/section/[role=group] container):
 *  only the recovered label text can mark it demographic. */
export const ASHBY_EEO_YESNO = `
<div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
  <label class="_heading_f7cvd_52 _label_1e3gg_42" for="eeo-uuid-0001">Do you have a disability status you wish to disclose? (Voluntary Self-Identification)</label>
  <div class="_container_1svni_28 _yesno_1e3gg_148">
    <button class="_container_pjyt6_1 _option_1svni_32">Yes</button>
    <button class="_container_pjyt6_1 _option_1svni_32">No</button>
    <input type="checkbox" class="_input_1svni_78" tabindex="-1" name="eeo-uuid-0001">
  </div>
</div>`

/** Optional field: label has NO required class token and NO '*', input has no
 *  required attribute. Must stay required:false. */
export const ASHBY_OPTIONAL_FIELD = `
<div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
  <label class="_heading_f7cvd_52 _label_1e3gg_42" for="opt-uuid-0001">LinkedIn Profile</label>
  <div><input placeholder="Type here..." name="opt-uuid-0001" id="opt-uuid-0001" type="text" class="_input_80epu_28 _input_1e3gg_32" value=""></div>
</div>`

/** Required via class token ONLY: no required attribute, no '*', hashed token
 *  `_required_f7cvd_91` on the (resolvable) label. */
export const ASHBY_REQUIRED_BY_CLASS = `
<div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
  <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42" for="req-uuid-0001">Preferred First Name</label>
  <div><input placeholder="Type here..." name="req-uuid-0001" id="req-uuid-0001" type="text" class="_input_80epu_28 _input_1e3gg_32" value=""></div>
</div>`

/** Required via a literal '*' in the label's RAW text (clean() strips it from
 *  the returned label text). */
export const STAR_REQUIRED_FIELD = `
<div class="field">
  <label for="phone-input">Phone *</label>
  <input id="phone-input" name="phone" type="text">
</div>`

/** Styled hidden checkbox: resolvable label, NO sibling buttons. Stays kind
 *  `checkbox` and survives the panel junk filter via its label. */
export const STYLED_HIDDEN_CHECKBOX = `
<div class="field">
  <label for="tos-check">I agree to the terms of service</label>
  <input type="checkbox" id="tos-check" name="tos" class="visually-hidden">
  <span class="checkmark"></span>
</div>`

/** reCAPTCHA response textarea: hidden, unlabelled — junk the panel must drop
 *  from resolve, auto-fill and render. */
export const RECAPTCHA_TEXTAREA = `
<div>
  <textarea id="g-recaptcha-response" name="g-recaptcha-response" class="g-recaptcha-response"></textarea>
</div>`

/** Select whose selected option is a "Select…" placeholder (empty value):
 *  currentValue must be null. */
export const SELECT_WITH_PLACEHOLDER = `
<div class="field">
  <label for="country-select">Country</label>
  <select id="country-select" name="country">
    <option value="" selected>Select…</option>
    <option value="br">Brazil</option>
    <option value="pt">Portugal</option>
  </select>
</div>`

/** Two inputs under ONE wrapper with a dangling wrapper label: the inputs must
 *  keep DISTINCT labels (their placeholders), never share "Name". */
export const SHARED_WRAPPER_FIRST_LAST = `
<div class="_fieldEntry_1e3gg_28">
  <label class="_heading_f7cvd_52 _label_1e3gg_42" for="name-uuid-0001">Name</label>
  <div class="nameRow">
    <input type="text" name="first" placeholder="First name">
    <input type="text" name="last" placeholder="Last name">
  </div>
</div>`
