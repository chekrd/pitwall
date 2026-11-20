// LikeC4 models of a made-up billing service: the standing one in its main checkout, a task's that adds a retry queue
// for webhooks, and one that does not parse.

const SPEC = `specification {
  element actor {
    notation 'Person'
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
  element queue {
    style {
      shape queue
    }
  }
}
`;

const VIEWS = `views {
  view index {
    title 'Billing in context'
    include *
  }

  view billing of billing {
    title 'Billing containers'
    include *
  }

  view api of billing.api {
    title 'Billing API components'
    include *
  }
}
`;

const model = (webhooks: string, extra: string, reports: string) => `model {
  customer = actor 'Customer' {
    description 'Pays the invoices a shop sends'
  }
  shop = system 'Shop' {
    description 'Sells things and bills through Billing'
  }
  stripe = system 'Stripe' {
    description 'Card payments'
  }

  billing = system 'Billing' {
    description 'Invoices, payments and webhooks for the shop'

    api = container 'Billing API' {
      technology 'Node, Hono'
      description 'REST API for invoices and payments'
      link ../../src/api 'Source'

      invoices = component 'Invoices' {
        technology 'TypeScript'
        description 'Creates and renders invoices'
        link ../../src/api/invoices.ts
      }
      payments = component 'Payments' {
        technology 'TypeScript'
        description 'Charges cards through Stripe'
      }
      webhooks = component 'Webhook sender' {
        technology 'TypeScript'
        description '${webhooks}'
      }
${extra}
      invoices -> payments 'charges'
      payments -> webhooks '${reports}'
    }

    db = database 'Postgres' {
      technology 'PostgreSQL 17'
      description 'Invoices, payments and customers'
    }

    api.invoices -> db 'reads and writes'
    api.payments -> db 'records payments'
  }

  customer -> billing.api 'pays invoices'
  shop -> billing.api 'creates invoices'
  billing.api.payments -> stripe 'charges cards'
  billing.api.webhooks -> shop 'notifies of paid invoices'
}
`;

export const STANDING_MODEL = {
  'spec.c4': SPEC,
  'model.c4': model('Tells the shop about paid invoices', '', 'reports paid invoices'),
  'views.c4': VIEWS,
};

export const RETRIES_MODEL = {
  'spec.c4': SPEC,
  'model.c4': model('Tells the shop about paid invoices; a failed delivery goes to the retry queue', `      retries = queue 'Retry queue' {
        technology 'Postgres table'
        description 'Failed deliveries, retried with backoff'
      }
      webhooks -> retries 'queues failed deliveries'
      retries -> webhooks 'retries after backoff'
`, 'emits paid events'),
  'views.c4': VIEWS,
};

export const BROKEN_MODEL = {
  'spec.c4': SPEC,
  'model.c4': model('Tells the shop about paid invoices', '      retries = queue \'Retry queue\' {\n        technology \'Postgres table\'\n\n', 'reports paid invoices'),
  'views.c4': VIEWS,
};
