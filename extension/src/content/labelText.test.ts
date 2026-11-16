import { beforeEach, describe, expect, it } from 'vitest'
import { isUploadWording, labelText } from './labelText'

beforeEach(() => { document.body.innerHTML = '' })

function el(html: string): Element {
  document.body.innerHTML = html
  return document.body.firstElementChild!
}

describe('labelText: a label read without the text of the Controls inside it', () => {
  it('reads a plain label as its whitespace-folded text', () => {
    expect(labelText(el('<label>  First\n   name </label>'))).toBe('First name')
  })

  it("leaves out a dropdown's Options", () => {
    const label = el('<label>Gender<select><option>Select ...</option><option>Male</option><option>Female</option></select></label>')
    expect(labelText(label)).toBe('Gender')
  })

  it("leaves out a button's words", () => {
    expect(labelText(el('<label>Portfolio <button type="button">Remove</button></label>'))).toBe('Portfolio')
  })

  it("leaves out a text area's content and an ARIA list box's Options", () => {
    expect(labelText(el('<label>Notes<textarea>typed text</textarea></label>'))).toBe('Notes')
    expect(labelText(el('<div>Country<ul role="listbox"><li role="option">Brazil</li></ul></div>'))).toBe('Country')
  })

  it('leaves out the text the page hides inside the label', () => {
    const label = el('<label><div>Race<a href=""></a></div><select><option>Asian</option></select>'
      + '<ul style="display: none;"><li><div>Asian</div><div>A person having origins in Asia.</div></li></ul>'
      + '<span hidden>Hidden note</span></label>')
    expect(labelText(label)).toBe('Race')
  })

  it('keeps the text that sits between Controls', () => {
    expect(labelText(el('<label><span>Start</span><select><option>Jan</option></select> date</label>'))).toBe('Start date')
  })

  it('leaves the page untouched', () => {
    const label = el('<label>Gender<select><option>Male</option></select></label>')
    labelText(label)
    expect(label.querySelectorAll('option')).toHaveLength(1)
  })

  it('is empty for a label that holds only a Control', () => {
    expect(labelText(el('<label><button>Attach</button></label>'))).toBe('')
  })
})

describe('isUploadWording: the words of an upload button', () => {
  it.each(['Attach', 'Upload a file', 'Replace file', 'Uploading...'])('takes "%s"', (wording) => {
    expect(isUploadWording(wording)).toBe(true)
  })

  it('ignores case and trailing dots', () => {
    expect(isUploadWording('ATTACH')).toBe(true)
    expect(isUploadWording('Uploading')).toBe(true)
    expect(isUploadWording('Upload a file.')).toBe(true)
    expect(isUploadWording('  replace FILE… ')).toBe(true)
  })

  it('refuses a question and a wording inside one', () => {
    expect(isUploadWording('Resume/CV')).toBe(false)
    expect(isUploadWording('Attach your resume')).toBe(false)
    expect(isUploadWording('Cover Letter')).toBe(false)
    expect(isUploadWording(null)).toBe(false)
    expect(isUploadWording('')).toBe(false)
  })
})
