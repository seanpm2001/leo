const camelCase = require('lodash.camelcase')
const fileHeader = require('../web/fileHeader')
const { createPropertyNameFormatter } = require('./createPropertyFormatter')

const { formatName } = createPropertyNameFormatter('css', { indentation: '' })

const THEMED_COLOR_GROUP_PARENT_KEYS = ['color', 'legacy', 'elevation']
const FAKE_PROPERTY_NAME = 'toString'

function isToken(tokenOrTokenCategory) {
  return !!tokenOrTokenCategory.type
}

function cleanKey(key) {
  return camelCase(key.trim())
}

function removeSegmentFromNameInAllTokens(tokenCategory, nameSegment) {
  const result = {}
  for (const key in tokenCategory) {
    const value = tokenCategory[key]
    if (isToken(value)) {
      result[key] = {
        ...tokenCategory[key],
        name: tokenCategory[key].name?.replace(`-${nameSegment}-`, '-')
      }
      continue
    }

    const cleaned = removeSegmentFromNameInAllTokens(value, nameSegment)
    if (key === nameSegment) {
      Object.assign(result, cleaned)
    } else {
      result[key] = cleaned
    }
  }
  return result
}

function formattedVariables(properties) {
  const result = {
    // The nonsensical 'toString' property exists to force the category
    // objects to not be interpreted by styled-components as a CSSObject
    // (which only allows string values, so we use an array here)
    // in the event a developer forgets to choose a low-level token property
    // with a string value. It's named toString to attempt to avoid any confusion.
    // https://github.com/brave/leo/pull/187#issuecomment-1410907561
    [FAKE_PROPERTY_NAME]: ['']
  }
  for (const key in properties) {
    let value = properties[key]
    if (!isToken(value)) {
      // If we are a collection of colors, which we have dark and light versions
      // we only want to export the themeless version
      // (i.e. without the 'dark' and 'light' parts of the name)
      // as that is what the css variable formatter does too.
      // TODO(petemill): This is ugly, there's got to be a cleaner way, or at least centralize this between
      // web, tailwind and styled-components.
      const hasDarkAndLightChildGroups = !!value.dark && !!value.light
      if (
        THEMED_COLOR_GROUP_PARENT_KEYS.includes(key) &&
        hasDarkAndLightChildGroups
      ) {
        value = {
          ...value,
          // Make a copy of the light tokens (they all point to the CSS variable
          // without the `light` path segment). These will be our themeless
          // tokens.
          ...removeSegmentFromNameInAllTokens(value['light'], 'light')
        }

        // Delete the separate dark/light property
        delete value['light']
        delete value['dark']
      }

      result[cleanKey(key)] = formattedVariables(value)
      continue
    }
    const name = formatName(value)
    result[cleanKey(key)] = `var(${name})`
  }
  return result
}

module.exports = ({ dictionary, file }) => {
  let fileContents = fileHeader({ file }) + '\n'

  // The `desktop` segment is ignored in our property names, so make sure we
  // remove it from the properties, or this won't match up with the actual CSS
  // variables.
  const properties = removeSegmentFromNameInAllTokens(
    dictionary.properties,
    'desktop'
  )
  const themeObject = formattedVariables(properties)
  // Separate out each main property, to allow for tree shaking and easy type-to-complete
  // imports in code editors.
  for (const property in themeObject) {
    if (property === FAKE_PROPERTY_NAME) {
      continue
    }
    fileContents +=
      `export const ${property} = ` +
      JSON.stringify(themeObject[property], null, 2) +
      ' as const \n'
  }
  return fileContents
}
