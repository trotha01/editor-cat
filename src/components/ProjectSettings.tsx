/**
 * The project section of Settings: what the open project is called.
 *
 * This is the only place a project is renamed. The header used to hold a text
 * field, but the title there is now the way into the project menu, and one
 * control cannot both switch projects and take typing — so the rare half of the
 * job moved here, where a field is unambiguous and nothing else is competing for
 * the click.
 *
 * There is no save button because there is nothing to save: the name is part of
 * the project document, so it persists locally on every keystroke and goes up
 * with the same debounce as every other edit.
 */
import { Field, TextInput } from './ui'
import { useProjectStore } from '../state/useProjectStore'

export function ProjectSettings() {
  const name = useProjectStore((state) => state.project.name)
  const rename = useProjectStore((state) => state.rename)

  return (
    <section className="rounded-lg border border-line bg-surface p-3">
      <Field
        label="Project name"
        htmlFor="project-name"
        hint="Shown in the header, and in the menu you switch projects from."
      >
        <TextInput
          id="project-name"
          value={name}
          placeholder="Untitled project"
          onChange={(event) => rename(event.target.value)}
        />
      </Field>
    </section>
  )
}
