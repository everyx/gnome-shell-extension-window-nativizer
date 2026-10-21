import {Journal, journal} from '../src/platform/journal.js';
import {bufferAllocationWarning} from '../src/lib/diagnosticInvariants.js';

/**
 * The prefix belongs to the journal, not to the text: that is the whole point of the module. These
 * specs pin both halves of the contract, because either half alone can lose it - a builder that
 * writes its own prefix doubles it, and a journal that forgets it writes lines nobody finds.
 */
describe('Journal (one sink, one prefix)', () => {
    it('tags every line it writes, so a support log can be searched for it', () => {
        const warn = jasmine.createSpy('warn');
        const sink = new Journal({warn});

        sink.warn('Offscreen box disagrees');

        expect(warn).toHaveBeenCalledOnceWith('[window-nativizer] Offscreen box disagrees');
    });

    it('completes a builder\'s text into the line the journal actually carries', () => {
        // The two halves are what a reader sees on one line: the predicate decides the content, the
        // journal decides the tag. Asserting them apart is how the prefix went missing in a refactor.
        const warn = jasmine.createSpy('warn');
        const text = bufferAllocationWarning({width: 300, height: 200}, {width: 400, height: 200});

        new Journal({warn}).warn(text);

        expect(warn.calls.mostRecent().args[0])
            .toMatch(/^\[window-nativizer\] Window buffer \d+x\d+ at \(\d+,\d+\) disagrees/);
    });

    it('routes a caught error to its own sink with the same tag', () => {
        const failure = jasmine.createSpy('failure');
        const error = new Error('boom');

        new Journal({failure}).failure(error, 'Failed to tear down the window picker');

        expect(failure).toHaveBeenCalledOnceWith(error,
            '[window-nativizer] Failed to tear down the window picker');
    });

    it('exposes one shared journal, so a decoration and the effects it builds write to one place', () => {
        expect(journal).toEqual(jasmine.any(Journal));
    });
});
