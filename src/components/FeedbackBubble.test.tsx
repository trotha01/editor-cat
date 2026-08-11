import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { IssueSupport } from '../lib/feedback/issues'

/**
 * The report form, and the two things it owes the person using it.
 *
 * Nothing is filed until Post is pressed — there is no other path from the
 * browser to the endpoint, and this is where that stays true. And everything
 * the issue will carry is on screen first, the reporter's own email included:
 * this posts to a public tracker, so publishing somebody's address without
 * having shown it to them would be the kind of surprise you only get to spring
 * once.
 */
const fileIssue = vi.fn()
const loadIssueSupport = vi.fn()

vi.mock('../lib/feedback/issues', () => ({
  loadIssueSupport: () => loadIssueSupport() as unknown,
  fileIssue: (input: unknown) => fileIssue(input) as unknown,
  supportContext: () => 'Build: abc1234 (main, production)',
  projectContext: () => 'Project: 2 clips, 8.0s, vertical',
}))

const { FeedbackBubble } = await import('./FeedbackBubble')

const READY: IssueSupport = {
  configured: true,
  repo: 'owner/repo',
  reporter: 'someone@example.com',
  mocked: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  loadIssueSupport.mockResolvedValue(READY)
  fileIssue.mockResolvedValue({ number: 412, url: 'https://github.com/owner/repo/issues/412' })
})

function press(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }))
}

function type(name: string, value: string) {
  fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })
}

/** Opens the form and waits for the deployment's answer about filing. */
async function openForm() {
  render(<FeedbackBubble />)
  press('Report a problem or suggest a feature')
  await screen.findByRole('textbox', { name: 'Title' })
}

async function writeReport() {
  await openForm()
  type('Title', 'Captions drift after a cut')
  type('Details', 'They drift by about a second.')
}

describe('the bubble', () => {
  it('stays out of the way until it is opened', () => {
    render(<FeedbackBubble />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Report a problem or suggest a feature' }),
    ).toBeInTheDocument()
  })

  it('keeps a half-written report when it is closed and opened again', async () => {
    await writeReport()

    press('Close')
    press('Report a problem or suggest a feature')

    // Losing what someone typed because they went to check what the bug does is
    // how a report never gets filed.
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue(
      'Captions drift after a cut',
    )
  })

  it('says so, rather than taking a report nowhere, where filing is not set up', async () => {
    loadIssueSupport.mockResolvedValue({
      configured: false,
      repo: null,
      reporter: null,
      mocked: false,
    })

    render(<FeedbackBubble />)
    press('Report a problem or suggest a feature')

    expect(await screen.findByText(/no issue tracker configured/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument()
  })
})

describe('filing', () => {
  it('posts nothing until the button is pressed', async () => {
    await writeReport()
    expect(fileIssue).not.toHaveBeenCalled()

    press(/Post to GitHub/)

    await waitFor(() => expect(fileIssue).toHaveBeenCalledTimes(1))
    expect(fileIssue.mock.calls[0]![0]).toMatchObject({
      kind: 'bug',
      title: 'Captions drift after a cut',
      body: 'They drift by about a second.',
      context: expect.stringContaining('Build: abc1234'),
    })
  })

  it('will not post an empty report', async () => {
    await openForm()
    expect(screen.getByRole('button', { name: /Post to GitHub/ })).toBeDisabled()

    type('Title', 'Something is wrong')
    expect(screen.getByRole('button', { name: /Post to GitHub/ })).toBeDisabled()

    type('Details', 'and here is what.')
    expect(screen.getByRole('button', { name: /Post to GitHub/ })).toBeEnabled()
  })

  it('carries the kind the reporter picked', async () => {
    await writeReport()
    press('I want something')
    press(/Post to GitHub/)

    await waitFor(() => expect(fileIssue).toHaveBeenCalled())
    expect(fileIssue.mock.calls[0]![0]).toMatchObject({ kind: 'feature' })
  })

  it('says where it went, as something you can follow', async () => {
    await writeReport()
    press(/Post to GitHub/)

    expect(await screen.findByRole('link', { name: 'owner/repo/issues/412' })).toHaveAttribute(
      'href',
      'https://github.com/owner/repo/issues/412',
    )
  })

  it('keeps what was written when posting fails', async () => {
    fileIssue.mockRejectedValue(new Error('Sign in again, then post this report.'))

    await writeReport()
    press(/Post to GitHub/)

    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in again')
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Captions drift after a cut')
  })

  it('says plainly that nothing was posted in mock mode', async () => {
    loadIssueSupport.mockResolvedValue({ ...READY, mocked: true, repo: null })
    fileIssue.mockResolvedValue({ number: null, url: null })

    await openForm()
    type('Title', 'Something is wrong')
    type('Details', 'and here is what.')
    press(/Post \(mock\)/)

    expect(await screen.findByText(/Nothing was posted/)).toBeInTheDocument()
  })
})

describe('what it will publish', () => {
  it('shows the address the issue will carry before anything is posted', async () => {
    await openForm()

    // The address comes back from the server, which is also what will attach
    // it — so this is the string that will appear, not a promise about one.
    expect(screen.getByText(/Reported by: someone@example\.com/)).toBeInTheDocument()
  })

  it('says an account id will go on it where the site has no address', async () => {
    loadIssueSupport.mockResolvedValue({ ...READY, reporter: null })

    await openForm()

    // A blank where the address would be reads as "nothing about you is
    // attached", which would not be true.
    expect(screen.getByText(/your account id/)).toBeInTheDocument()
  })

  it('shows the build and project details too', async () => {
    await openForm()

    expect(screen.getByText(/Build: abc1234/)).toBeInTheDocument()
    expect(screen.getByText(/Project: 2 clips/)).toBeInTheDocument()
  })

  it('says the issue will be public, and where', async () => {
    await openForm()
    expect(screen.getByText('Public issue on owner/repo')).toBeInTheDocument()
  })
})
