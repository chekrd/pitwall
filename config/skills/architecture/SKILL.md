---
name: architecture
description: Write or update the repository's architecture as a LikeC4 model in .pitwall/architecture/, which Pitwall draws as an interactive diagram on the task's Architecture tab. Use for /architecture, "model the architecture" or "update the architecture diagram"; `/architecture <change>` models what the task changes.
---

Keep the repository's architecture as a [LikeC4](https://likec4.dev) model: text files that Pitwall lays out and draws on the task's **Architecture** tab (key 6), where the user pans, zooms, opens an element's details and clicks into the diagram of an element.

## Where it lives

- `.pitwall/architecture/*.c4` at the root of the checkout you work in. In a task across a folder of repositories, each repository's worktree has its own.
- One model per repository, split across a few files: `spec.c4` (the kinds), `model.c4` (or `model-<area>.c4` for a large system), `views.c4`. Only `.c4` files directly in that folder are read; no subfolders, no `likec4.config.json`.
- git ignores `.pitwall/` through the repository's `.git/info/exclude`. Never commit the model and never add it to `.gitignore`.
- The repository's main checkout holds the project's model, and a new worktree starts with a copy of it. Change only the copy in your worktree, never the main checkout: the user decides on the board whether your model becomes the project's.

## What to do

1. Read every file of the model if there is one.
2. Read the code before writing: entry points, package manifests, Dockerfiles and deployment config, how the parts talk (HTTP, queues, databases, other services).
   - `/architecture`: model what exists now, not what you plan.
   - `/architecture <change>`: if there is no model yet, model what exists first; then change it to show what the task changes, and only that.
3. Model in C4 levels: the context (people, this system, the external systems it talks to), the containers inside the system (apps, services, databases, queues), and components inside a container only where they help. No classes or files.
4. Give each element a title, a one-sentence `description`, a `technology` on containers and components, and a `link` to its source, relative to the `.c4` file (`link ../../src/api 'Source'` points at `src/api`).
5. Keep the id of an element and the title of a relationship that did not change. The board compares a task's model with the project's by element id and by each relationship's source, target, kind and title, so a renamed id or title shows as one removed and one added.
6. Add `view index` for the context and one scoped view per element that has children (`view api of shop.api { include * }`). In a diagram, an element that has a scoped view leads into it, which is how the user drills down.
7. Check the model, from the root of the checkout, and fix every error: a model with errors shows only its errors on the board.

   ```sh
   node {{PITWALL}}/scripts/architecture.ts check
   ```

   It lays the model out with the same LikeC4 code as the board, without the network, and prints `file:line:column message` per error, or `ok: …` with the views.
8. End by saying in a few lines what you modelled or changed: elements and relationships added, removed and changed, and the views.

Don't use `icon` (icons load from LikeC4's website, which the board does not allow), `deployment` blocks or `import`. Leave green and amber to the board, which marks a task's additions and changes with them.

## LikeC4 in brief

- Top-level blocks: `specification`, `model`, `views` (all may repeat across files and are merged).
- Every element kind is declared in `specification` before use: `element service { style { shape component } }`.
- An element: `id = kind 'Title' { … }` or `id = kind 'Title'`. Ids use letters, digits, `-` and `_`, never a dot, and don't start with a digit. Nested elements get dotted names: `shop.api.orders`.
- Inside an element, properties come first (`description`, `technology`, `link`, `style`), then nested elements and relationships.
- Strings take `'…'` or `"…"`; `'''…'''` holds Markdown.
- A relationship: `source -> target 'title'`, optionally `{ technology 'HTTPS' }`. Inside an element, `-> target 'title'` starts from that element. No relationship between an element and its own parent or child.
- Names resolve within the file; across files, use the full dotted name (`shop.api.orders`).
- Views: `view id { include * }` for the top level; `view id of fqn { include * }` for an element and its children. Rules: `include *`, `include shop.*`, `include -> shop.api ->` (with its neighbours), `exclude …`, `autoLayout TopBottom` (or `LeftRight`). `title '…'` names a view.
- Shapes: `rectangle`, `person`, `browser`, `mobile`, `cylinder`, `storage`, `queue`, `component`, `document`, `bucket`. Colours: `primary`, `secondary`, `muted`, `slate`, `blue`, `indigo`, `sky`, `red`, `gray`.
- Comments: `// …` and `/* … */`.

## Example

`spec.c4`:

```likec4
specification {
  element person {
    style {
      shape person
    }
  }
  element system
  element container
  element component
  element database {
    style {
      shape storage
    }
  }
}
```

`model.c4`:

```likec4
model {
  shopper = person 'Shopper' {
    description 'Buys things in the web shop'
  }
  payments = system 'Payment provider' {
    description 'Charges cards'
  }

  shop = system 'Shop' {
    description 'The web shop and its back end'

    web = container 'Web app' {
      technology 'React'
      description 'What shoppers use in the browser'
      link ../../web 'Source'
    }
    api = container 'API' {
      technology 'Node, Hono'
      description 'Orders and checkout'
      link ../../server 'Source'

      orders = component 'Orders' {
        description 'Places and tracks orders'
      }
      checkout = component 'Checkout' {
        description 'Takes payment for an order'
      }
      orders -> checkout 'starts checkout'
    }
    db = database 'Database' {
      technology 'PostgreSQL'
    }

    web -> api.orders 'places orders' {
      technology 'HTTPS'
    }
    api.orders -> db 'reads and writes'
  }

  shopper -> shop.web 'browses'
  shop.api.checkout -> payments 'charges cards'
}
```

`views.c4`:

```likec4
views {
  view index {
    title 'Shop in context'
    include *
  }
  view shop of shop {
    title 'Shop containers'
    include *
  }
  view api of shop.api {
    title 'API components'
    include *
  }
}
```
