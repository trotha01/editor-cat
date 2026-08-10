import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AssistantReply } from '../lib/support/chat'
import type { IssueSupport } from '../lib/support/issues'

/**
 * The bubble, and the one rule it exists to keep.
 *
 * A report is written by a model, from a conversation, on behalf of somebody
 * who may never look at the tracker again — and it is posted publicly under the
 * deployment's own account. So the thing worth testing here is not that the
 * chat works but that **nothing reaches GitHub without a person pressing the
 * button on a draft they can see and edit**. If that ever quietly stops being
 * true, this file is what should fail.
 */
const askAssistant = vi.fn()
const fileIssue = vi.fn()
const loadIssueSupport = vi.fn()

vi.mock('../lib/support/chat', () => ({
  askAssistant: (options: unknown) => askAssistant(options) as unknown,
}))

vi.mock('../lib/support/issues', () => ({
  loadIssueSupport: () => loadIssueSupport() as unknown,
  fileIssue: (input: unknown) => fileIssue(input) as unknown,
  supportContext: () => 'Build: abc1234 (main, production)',
  projectContext: () => 'Project: 2 clips, 8.0s, vertical',
}))

const { HelpChat } = await import('./HelpChat')

const CAN_FILE: IssueSupport = { configured: true, repo: 'owner/repo', mocked: false }

const DRAFTED: AssistantReply = {
  text: 'That sounds like a bug. Here is a draft.',
  draft: { kind: 'bug', title: 'Captions drift after a cut', body: 'They drift by a second.' },
}

beforeEach(() => {
  vi.clearAllMocks()
  loadIssueSupport.mockResolvedValue(CAN_FILE)
  askAssistant.mockResolvedValue({ text: 'Drag the clip’s edge to trim it.', draft: null })
  fileIssue.mockResolvedValue({ number: 412, url: 'https://github.com/owner/repo/issues/412' })
})

function press(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }))
}

/**
 * Opens the bubble and lets it settle.
 *
 * It asks whether this deployment can file anything before it offers to, and
 * the answer changes both what the intro says and what the model is told — so
 * a test that types before that lands is testing the wrong branch.
 */
async function openChat() {
  render(<HelpChat />)
  press('Open help and feedback')
  await waitFor(() => expect(screen.queryByText(/You can also tell me/)).not.toBeInTheDocument())
}

function ask(question: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: question },
  })
  press('Send')
}

function type(name: string, value: string) {
  fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })
}

describe('the bubble', () => {
  it('stays out of the way until it is opened', async () => {
    render(<HelpChat />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open help and feedback' })).toBeInTheDocument()
  })

  it('keeps the conversation when it is closed and opened again', async () => {
    await openChat()
    ask('How do I trim?')
    await screen.findByText('Drag the clip’s edge to trim it.')

    press('Close help')
    press('Open help and feedback')

    // A chat you have to start again because you looked at the timeline is one
    // nobody uses twice.
    expect(screen.getByText('Drag the clip’s edge to trim it.')).toBeInTheDocument()
  })
})

describe('answering a question', () => {
  it('sends the conversation and shows the reply', async () => {
    await openChat()
    ask('How do I trim a clip?')

    expect(await screen.findByText('Drag the clip’s edge to trim it.')).toBeInTheDocument()
    expect(askAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', text: 'How do I trim a clip?' }],
        canFile: true,
        repo: 'owner/repo',
      }),
    )
  })

  it('carries the earlier turns into the next question', async () => {
    await openChat()
    ask('How do I trim a clip?')
    await screen.findByText('Drag the clip’s edge to trim it.')
    ask('And split one?')

    await waitFor(() => expect(askAssistant).toHaveBeenCalledTimes(2))
    const { messages } = askAssistant.mock.calls[1]![0] as { messages: unknown[] }
    expect(messages).toHaveLength(3)
  })

  it('shows a failure without ending the conversation', async () => {
    askAssistant.mockRejectedValue(new Error('fal.ai is rate limiting you.'))

    await openChat()
    ask('How do I trim a clip?')

    expect(await screen.findByRole('alert')).toHaveTextContent('rate limiting')

    // The failure stays on screen but is not fed back to the model as though
    // the assistant had said it.
    askAssistant.mockResolvedValue({ text: 'Drag its edge.', draft: null })
    ask('again?')

    await waitFor(() => expect(askAssistant).toHaveBeenCalledTimes(2))
    const { messages } = askAssistant.mock.calls[1]![0] as { messages: { text: string }[] }
    expect(messages.some((message) => message.text.includes('rate limiting'))).toBe(false)
  })

  it('tells the assistant when this deployment cannot file anything', async () => {
    loadIssueSupport.mockResolvedValue({ configured: false, repo: null, mocked: false })

    await openChat()
    expect(screen.getByText(/not set up on this deployment/)).toBeInTheDocument()

    ask('This is broken')

    await waitFor(() => expect(askAssistant).toHaveBeenCalled())
    expect(askAssistant.mock.calls[0]![0]).toMatchObject({ canFile: false })
  })
})

describe('a drafted report', () => {
  it('is shown for review, and posted only when the button is pressed', async () => {
    askAssistant.mockResolvedValue(DRAFTED)

    await openChat()
    ask('The captions are in the wrong place')

    const title = await screen.findByRole('textbox', { name: 'Report title' })
    expect(title).toHaveValue('Captions drift after a cut')

    // The whole point: a draft on screen is not a filed issue.
    expect(fileIssue).not.toHaveBeenCalled()

    press(/Post to GitHub/)

    await waitFor(() => expect(fileIssue).toHaveBeenCalledTimes(1))
    // And says where it went, as something you can actually follow.
    expect(await screen.findByRole('link', { name: 'owner/repo/issues/412' })).toHaveAttribute(
      'href',
      'https://github.com/owner/repo/issues/412',
    )
  })

  it('shows what will be attached before it is attached', async () => {
    askAssistant.mockResolvedValue(DRAFTED)

    await openChat()
    ask('The captions are in the wrong place')
    await screen.findByRole('textbox', { name: 'Report title' })

    // Adding a user agent to somebody's public report without showing it to
    // them first is not a thing to do quietly.
    expect(screen.getByText(/Build: abc1234/)).toBeInTheDocument()
    expect(screen.getByText(/Project: 2 clips/)).toBeInTheDocument()
  })

  it('posts what the reporter edited, not what the model wrote', async () => {
    askAssistant.mockResolvedValue(DRAFTED)

    await openChat()
    ask('The captions are in the wrong place')

    await screen.findByRole('textbox', { name: 'Report title' })
    type('Report title', 'Captions land a second late')
    press('Feature request')
    press(/Post to GitHub/)

    await waitFor(() => expect(fileIssue).toHaveBeenCalled())
    expect(fileIssue.mock.calls[0]![0]).toMatchObject({
      kind: 'feature',
      title: 'Captions land a second late',
      context: expect.stringContaining('Build: abc1234'),
    })
  })

  it('files nothing at all when the draft is discarded', async () => {
    askAssistant.mockResolvedValue(DRAFTED)

    await openChat()
    ask('The captions are in the wrong place')
    await screen.findByRole('textbox', { name: 'Report title' })

    press('Discard')

    expect(screen.queryByRole('textbox', { name: 'Report title' })).not.toBeInTheDocument()
    expect(fileIssue).not.toHaveBeenCalled()
  })

  it('keeps the draft on screen when posting fails', async () => {
    askAssistant.mockResolvedValue(DRAFTED)
    fileIssue.mockRejectedValue(new Error('Sign in again, then post this report.'))

    await openChat()
    ask('The captions are in the wrong place')
    await screen.findByRole('textbox', { name: 'Report title' })
    press(/Post to GitHub/)

    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in again')
    // Losing what someone wrote because the post failed is how a report is
    // never filed at all.
    expect(screen.getByRole('textbox', { name: 'Report title' })).toBeInTheDocument()
  })

  it('says plainly that nothing was posted in mock mode', async () => {
    loadIssueSupport.mockResolvedValue({ configured: true, repo: null, mocked: true })
    askAssistant.mockResolvedValue(DRAFTED)
    fileIssue.mockResolvedValue({ number: null, url: null })

    await openChat()
    ask('The captions are in the wrong place')
    await screen.findByRole('textbox', { name: 'Report title' })
    press(/Post \(mock\)/)

    expect(await screen.findByText(/Mock mode — nothing was posted/)).toBeInTheDocument()
  })
})
