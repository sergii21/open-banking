import { TestBed } from '@angular/core/testing';
import { Segmented } from './segmented';

async function render(value: 'screen' | 'all' = 'screen') {
  const fixture = TestBed.createComponent<Segmented<'screen' | 'all'>>(Segmented);
  fixture.componentRef.setInput('label', 'Which calls to show');
  fixture.componentRef.setInput('options', [
    { value: 'screen', label: 'This screen' },
    { value: 'all', label: 'All calls (3)' },
  ]);
  fixture.componentRef.setInput('value', value);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    el,
    radios: () => [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')],
  };
}

describe('Segmented', () => {
  it('is a labelled radio group with exactly one choice in the tab order', async () => {
    const { el, radios } = await render('all');
    expect(el.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe(
      'Which calls to show',
    );
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0]);
  });

  it('selects on click', async () => {
    const { fixture, radios } = await render('screen');
    radios()[1]?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('all');
    expect(radios()[1]?.getAttribute('aria-checked')).toBe('true');
  });

  it('moves with the arrow keys and wraps around, like any radio group', async () => {
    const { fixture, radios } = await render('screen');
    radios()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('all');
    radios()[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('screen');
    radios()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('all');
  });
});
