/**
 * The open project's name.
 *
 * Renaming lives here now rather than in the title bar, which switches
 * projects instead. The debounced push in useProjectsStore renames the
 * project's Drive folder to match once the name settles, so this one field
 * is what keeps both in step.
 */
import { Field, TextInput } from './ui'
import { useProjectStore } from '../state/useProjectStore'

export function ProjectSettings() {
  const name = useProjectStore((state) => state.project.name)
  const rename = useProjectStore((state) => state.rename)

  return (
    <Field label="Project name" htmlFor="project-name">
      <TextInput
        id="project-name"
        value={name}
        onChange={(event) => rename(event.target.value)}
        placeholder="Untitled project"
      />
    </Field>
  )
}
