import type { SvelteComponent } from 'svelte'

interface Options {
  mode: 'open' | 'closed'
  eventTypes: string[]
  name: string
}

// Properties with these types should be reflected to attributes.
const reflectToAttributes = new Set(['string', 'number', 'boolean'])

/**
 * This function creates a faux Svelte component which forwards WebComponent
 * slots into a Svelte slot.
 * @param name The name of the slot
 * @returns A Svelte "component" representing the slot.
 */
const createSlot = (name?: string) => {
  let slot: HTMLElement
  return {
    // Create
    c() {
      slot = document.createElement('slot')
      if (name) {
        slot.setAttribute('name', name)
      }
    },

    // Mount
    m(target, anchor) {
      target.insertBefore(slot, anchor || null)
    },

    // Props changed
    p() {},

    // Detach
    d(detaching) {
      if (detaching && slot.parentNode) {
        slot.parentNode.removeChild(slot)
      }
    }
  }
}

export default function registerWebComponent(
  component: any,
  { name, mode, eventTypes }: Options
) {
  if (customElements.get(name)) {
    console.log(`Attempted to register ${name} component multiple times.`)
    return
  }

  // Create & mount a dummy component. We use this to work out what props are
  // available and generate a list of available properties.
  const c = new component({ target: document.createElement('div') })

  // The names of all properties on our Svelte component.
  const props = Object.keys(c.$$.props)

  // A mapping of 'attributename' to 'propertyName', as attributes are
  // lowercase, while Svelte components are generally 'camelCase'.
  const attributePropMap = props.reduce((prev, next) => {
    prev.set(next.toLowerCase(), next)
    return prev
  }, new Map<string, string>())

  // Note attribute keys, so changes cause us to update our Svelte Component.
  const attributes = Array.from(attributePropMap.keys())

  // We need to handle boolean attributes specially, as the presence/absence of the attribute indicates the value.
  const boolProperties = new Set(
    props.filter((p) => typeof c.$$.ctx[c.$$.props[p]] === 'boolean')
  )

  class SvelteWrapper extends HTMLElement {
    #component: SvelteComponent
    get component() {
      return this.#component
    }

    set component(value) {
      // We need to make sure that when we recreate the component (as in the
      // case of slots changing) that we copy over all of the event listeners.
      this.#component = value

      // Make sure we forward events from the new component, otherwise our
      // listeners will break.
      for (const type of eventTypes) this.#ensureEventForwarder(type)
    }

    static get observedAttributes() {
      return attributes
    }

    constructor() {
      super()

      // Mount shadow - this is where we're going to render our Component.
      // Note: In some rare cases, the shadow root might already exist,
      // especially when being rendered inside a Polymer dom-if. In this case,
      // we need to also clear the contents of the node, to ensure we don't
      // duplicate content.
      const shadow = this.shadowRoot ?? this.attachShadow({ mode })
      shadow.replaceChildren()

      let lastSlots = new Set()
      const updateSlots = () => {
        const slotsNames = Array.from(this.children).map((c) =>
          c.getAttribute('slot')
        )
        // Add default slot
        if (this.childNodes.length) slotsNames.push(undefined)

        // Slots didn't change, so nothing to do here.
        // The component needs to get created, at least once
        if (
          this.component &&
          // If the size is the same, and every one of our last slots
          // is present, then nothing has changed, and we don't need
          // to do anything here.
          lastSlots.size === slotsNames.length &&
          slotsNames.every((s) => lastSlots.has(s))
        ) {
          return
        }

        // Update the last slots we have, so if they change we know to update them.
        lastSlots = new Set(slotsNames)

        // Create a dictionary of the slotName: <slot name={slotName}/>
        const slots = slotsNames.reduce(
          (prev, next) => ({
            ...prev,
            [next ?? 'default']: [() => createSlot(next)]
          }),
          {}
        )

        // If we've already created the component, we might have some
        // existing props. We need to create a snapshot of the component
        // so we can recreate it as faithfully as possible.
        // Note: We might be able to do some additional hackery here
        // to copy over even more information from $$.ctx and exactly
        // maintain the component state!
        const existingProps = Object.keys(this.component?.$$.props ?? {})
          .map((k) => [k, this[k]])
          .reduce((prev, [key, value]) => ({ ...prev, [key]: value }), {})

        // If the component already exists, destroy it. This is,
        // unfortunately, necessary as there is no way to update slotted
        // content in the output Svelte compiles to. This is a problem
        // even when not doing crazy things:
        // https://github.com/sveltejs/svelte/issues/5312
        if (this.component) {
          this.component.$destroy()
        }

        // Finally, we actually create the component
        this.component = new component({
          // Target this shadowDOM, so we get nicely encapsulated
          // styles
          target: shadow,
          props: {
            // Copy over existing props (there might be none, if
            // this is our first render).
            ...existingProps,
            // Create WebComponent slots for each Svelte slot we
            // have content for. This has to be done at render or
            // Svelte won't support fallback content.
            $$slots: slots,
            // Not sure what this is needed for but Svelte crashes
            // without it. I think this might be related to slot
            // props:
            // https://svelte.dev/tutorial/slot-props
            $$scope: { ctx: [] }
          }
        })
      }

      // Unfortunately we need a DOMMutationObserver to let us know when
      // slotted content changes because we dynamically create & remove
      // slots. This is for two reasons:
      // 1) At runtime, we don't know what slots our Svelte component has
      // 2) Even if we did, if we generated all of the slots at mount time
      //    then Svelte would never render any of the fallback content,
      //    event if the slot was empty.
      new MutationObserver(updateSlots).observe(this, {
        childList: true,
        attributes: false,
        attributeOldValue: false,
        subtree: false,
        characterData: false,
        characterDataOldValue: false
      })

      // Update slots on create.
      updateSlots()

      // For some reason setting this on |SvelteWrapper| doesn't work properly.
      for (const prop of props) {
        Object.defineProperty(this, prop, {
          enumerable: true,
          get() {
            // $$.props is { [propertyName: string]: number } where the number
            // is the array index into $$.ctx that the value is stored in.
            const contextIndex = this.component.$$.props[prop]
            return this.component.$$.ctx[contextIndex]
          },
          set(value) {
            if (reflectToAttributes.has(typeof value)) {
              // Boolean attributes are special - presence/absence indicates
              // value, rather than actual value.
              if (boolProperties.has(prop)) {
                if (value) this.setAttribute(prop, '')
                else this.removeAttribute(prop)
              } else this.setAttribute(prop, value)
            }

            // |.$set| updates the value of a prop. Note: This only works for
            // props, not slotted content.
            this.component.$set({ [prop]: value })
          }
        })
      }
    }

    attributeChangedCallback(name, oldValue, newValue) {
      const prop = attributePropMap.get(name)
      if (!prop) return

      if (oldValue === newValue) return
      this[prop] = boolProperties.has(prop) ? newValue !== null : newValue
    }

    #ensureEventForwarder(type: string) {
      this.component.$on(type, (e) => this.dispatchEvent(e))
    }

    addEventListener(
      event: string,
      callback: EventListener,
      options?: boolean | AddEventListenerOptions
    ) {
      // If this is an event normally present on HTMLElements but is being
      // provided internally from the CustomElement we want to only trigger the
      // handler is this is a CustomEvent.
      let maybeWrapped = callback
      if (eventTypes.includes(event)) {
        maybeWrapped = (...args) => {
          if (!(args[0] instanceof CustomEvent)) return
          callback(...args)
        }
      }
      super.addEventListener(event, maybeWrapped, options)
    }
  }

  customElements.define(name, SvelteWrapper)
}
