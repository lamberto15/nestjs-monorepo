import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useAppForm } from '@/lib/form';
import { peopleHandler } from '@/test/people';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';

// A `user` field (an assigned agent): its value is a member's key, shown by
// their name, picked by searching the people.

const ANA = '0190a6a0-7c1e-7000-8000-00000000000a';
const BEN = '0190a6a0-7c1e-7000-8000-00000000000b';

function Form(props: { value: string; onValue: (value: string) => void }) {
  const form = useAppForm({
    defaultValues: { agentId: props.value },
    listeners: {
      onChange: ({ formApi }) => props.onValue(formApi.state.values.agentId),
    },
  });
  return (
    <form>
      <form.AppField name="agentId">
        {(f) => <f.PersonField label="Agent" />}
      </form.AppField>
    </form>
  );
}

describe('PersonField', () => {
  it("shows the current member's name, and takes another one's key", async () => {
    server.use(
      peopleHandler([
        { id: ANA, name: 'Ana Cruz' },
        { id: BEN, name: 'Ben Reyes' },
      ]),
    );
    const values: string[] = [];
    await renderComponent(
      <Form value={`user:${ANA}`} onValue={(value) => values.push(value)} />,
    );
    const agent = () => screen.getByRole('combobox', { name: 'Agent' });
    // The input starts again once the name is known: look it up each time.
    await waitFor(() => expect(agent()).toHaveValue('Ana Cruz'));
    const input = agent();
    await userEvent.click(input);
    // Dice UI takes the text a frame later: typed at once, not key by key.
    fireEvent.change(input, { target: { value: 'ben' } });
    await userEvent.click(
      await screen.findByRole('option', { name: /Ben Reyes/ }),
    );
    await waitFor(() => expect(values.at(-1)).toBe(`user:${BEN}`));
  });
});
