require("dotenv").config();

const express = require("express");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcrypt");
const Stripe = require("stripe");
const db = require("./database");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_STARTER = process.env.STRIPE_PRICE_STARTER;
const STRIPE_PRICE_GROWTH = process.env.STRIPE_PRICE_GROWTH;
const STRIPE_PRICE_PRO = process.env.STRIPE_PRICE_PRO;
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SESSION_SECRET = process.env.SESSION_SECRET || "blackorbit_secret_key";

if (!STRIPE_SECRET_KEY) {
  console.error("Falta STRIPE_SECRET_KEY no .env");
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

/* =========================
   HELPERS DB
========================= */

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

/* =========================
   HELPERS APP
========================= */

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login.html?error=login_required");
  }
  next();
}

function getPlanDetails(planKey) {
  const plans = {
    starter: {
      key: "starter",
      name: "Starter",
      price: "$3.99/mo",
      amount: "3.99",
      specs: "1 GB RAM • 10 GB NVMe • Shared CPU",
      serviceLimit: 1,
      stripePriceId: STRIPE_PRICE_STARTER
    },
    growth: {
      key: "growth",
      name: "Growth",
      price: "$6.99/mo",
      amount: "6.99",
      specs: "3 GB RAM • 25 GB NVMe • 2 vCPU Threads",
      serviceLimit: 3,
      stripePriceId: STRIPE_PRICE_GROWTH
    },
    pro: {
      key: "pro",
      name: "Pro",
      price: "$11.99/mo",
      amount: "11.99",
      specs: "6 GB RAM • 60 GB NVMe • 4 vCPU Threads",
      serviceLimit: 6,
      stripePriceId: STRIPE_PRICE_PRO
    }
  };

  return plans[planKey] || null;
}

function getPlanKeyFromPriceId(priceId) {
  if (priceId === STRIPE_PRICE_STARTER) return "starter";
  if (priceId === STRIPE_PRICE_GROWTH) return "growth";
  if (priceId === STRIPE_PRICE_PRO) return "pro";
  return null;
}

function formatDate(date = new Date()) {
  return date.toLocaleDateString("en-GB");
}

function nextRenewalDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return formatDate(d);
}

async function getUserById(userId) {
  return getQuery("SELECT * FROM users WHERE id = ?", [userId]);
}

async function getUserByEmail(email) {
  return getQuery("SELECT * FROM users WHERE email = ?", [email]);
}

async function getUserByStripeCustomerId(customerId) {
  return getQuery("SELECT * FROM users WHERE stripe_customer_id = ?", [customerId]);
}

async function getUserByStripeSubscriptionId(subscriptionId) {
  return getQuery("SELECT * FROM users WHERE stripe_subscription_id = ?", [subscriptionId]);
}

async function getServicesByUserId(userId) {
  return allQuery(
    "SELECT * FROM services WHERE user_id = ? ORDER BY id DESC",
    [userId]
  );
}

async function getInvoicesByUserId(userId) {
  return allQuery(
    "SELECT * FROM invoices WHERE user_id = ? ORDER BY id DESC",
    [userId]
  );
}

async function getLogsByServiceId(serviceId) {
  return allQuery(
    "SELECT * FROM service_logs WHERE service_id = ? ORDER BY id DESC",
    [serviceId]
  );
}

async function createServiceLog(serviceId, message) {
  await runQuery(
    `
    INSERT INTO service_logs (service_id, message, created_at)
    VALUES (?, ?, ?)
    `,
    [serviceId, message, new Date().toISOString()]
  );
}

/* =========================
   WEBHOOK
========================= */

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    try {
      const signature = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        const sessionObj = event.data.object;
        const stripeSessionId = sessionObj.id;

        const localSession = await getQuery(
          `
          SELECT * FROM checkout_sessions
          WHERE stripe_session_id = ?
          `,
          [stripeSessionId]
        );

        if (!localSession) {
          console.log("Sessão local não encontrada:", stripeSessionId);
          return res.json({ received: true });
        }

        const user = await getUserById(localSession.user_id);
        const plan = getPlanDetails(localSession.plan_key);

        if (!user || !plan) {
          console.log("Usuário ou plano não encontrado no webhook.");
          return res.json({ received: true });
        }

        const fullSession = await stripe.checkout.sessions.retrieve(stripeSessionId);

        const stripeCustomerId =
          typeof fullSession.customer === "string"
            ? fullSession.customer
            : fullSession.customer?.id || null;

        const stripeSubscriptionId =
          typeof fullSession.subscription === "string"
            ? fullSession.subscription
            : fullSession.subscription?.id || null;

        await runQuery(
          `
          UPDATE users
          SET active_plan = ?,
              payment_method = ?,
              payment_summary = ?,
              stripe_customer_id = ?,
              stripe_subscription_id = ?
          WHERE id = ?
          `,
          [
            plan.key,
            "Stripe",
            `Active subscription - ${plan.name} Plan`,
            stripeCustomerId,
            stripeSubscriptionId,
            user.id
          ]
        );

        await runQuery(
          `
          UPDATE checkout_sessions
          SET status = ?
          WHERE stripe_session_id = ?
          `,
          ["completed", stripeSessionId]
        );

        const amountTotal =
          typeof fullSession.amount_total === "number"
            ? (fullSession.amount_total / 100).toFixed(2)
            : plan.amount;

        await runQuery(
          `
          INSERT INTO invoices (
            user_id,
            invoice_number,
            description,
            amount,
            status,
            payment_method,
            issue_date,
            renewal_date
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            user.id,
            `INV-STRIPE-${Date.now()}`,
            `${plan.name} Plan`,
            `$${amountTotal}`,
            "Paid",
            "Stripe",
            formatDate(),
            nextRenewalDate()
          ]
        );

        console.log("Usuário atualizado para plano:", plan.key);
      }

      if (event.type === "customer.subscription.updated") {
        const subscription = event.data.object;

        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer?.id || null;

        const user = await getUserByStripeCustomerId(customerId);

        if (user) {
          let detectedPlanKey = null;

          if (subscription.items?.data?.length) {
            const priceId = subscription.items.data[0]?.price?.id || null;
            detectedPlanKey = getPlanKeyFromPriceId(priceId);
          }

          const subscriptionStatus = subscription.status;

          if (detectedPlanKey) {
            const plan = getPlanDetails(detectedPlanKey);

            await runQuery(
              `
              UPDATE users
              SET active_plan = ?,
                  payment_method = ?,
                  payment_summary = ?,
                  stripe_subscription_id = ?
              WHERE id = ?
              `,
              [
                plan.key,
                "Stripe",
                `Subscription status: ${subscriptionStatus} - ${plan.name} Plan`,
                subscription.id,
                user.id
              ]
            );

            console.log("Subscription updated:", subscriptionStatus, detectedPlanKey);
          }
        }
      }

      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;
        const subscriptionId = subscription.id;

        const user = await getUserByStripeSubscriptionId(subscriptionId);

        if (user) {
          await runQuery(
            `
            UPDATE users
            SET active_plan = NULL,
                payment_method = 'Stripe',
                payment_summary = 'Subscription canceled',
                stripe_subscription_id = NULL
            WHERE id = ?
            `,
            [user.id]
          );

          console.log("Subscription canceled for user:", user.id);
        }
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("Webhook handler error:", err);
      return res.status(500).send("Webhook handler failed");
    }
  }
);

/* =========================
   MIDDLEWARES
========================= */

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  })
);

app.use(express.static(path.join(__dirname, "public")));

/* =========================
   AUTH
========================= */

app.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.redirect("/register.html?error=empty_fields");
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await getUserByEmail(normalizedEmail);

    if (existingUser) {
      return res.redirect("/register.html?error=email_exists");
    }

    const hashedPassword = await bcrypt.hash(password.trim(), 10);

    const result = await runQuery(
      `
      INSERT INTO users (
        username,
        email,
        password,
        active_plan,
        payment_method,
        payment_summary,
        stripe_customer_id,
        stripe_subscription_id,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        username.trim(),
        normalizedEmail,
        hashedPassword,
        null,
        null,
        null,
        null,
        null,
        new Date().toISOString()
      ]
    );

    req.session.user = {
      id: result.lastID,
      username: username.trim(),
      email: normalizedEmail
    };

    return res.redirect("/dashboard");
  } catch (error) {
    console.error(error);
    return res.redirect("/register.html?error=server_error");
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.redirect("/login.html?error=empty_fields");
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await getUserByEmail(normalizedEmail);

    if (!user) {
      return res.redirect("/login.html?error=account_not_found");
    }

    let validPassword = false;

    if (user.password.startsWith("$2")) {
      validPassword = await bcrypt.compare(password.trim(), user.password);
    } else {
      validPassword = user.password === password.trim();

      if (validPassword) {
        const migratedHash = await bcrypt.hash(password.trim(), 10);
        await runQuery("UPDATE users SET password = ? WHERE id = ?", [
          migratedHash,
          user.id
        ]);
      }
    }

    if (!validPassword) {
      return res.redirect("/login.html?error=wrong_password");
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email
    };

    return res.redirect("/dashboard");
  } catch (error) {
    console.error(error);
    return res.redirect("/login.html?error=server_error");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html?success=logged_out");
  });
});

/* =========================
   PAGES
========================= */

app.get("/dashboard", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/checkout", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "checkout.html"));
});

app.get("/billing", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "billing.html"));
});

app.get("/create-service", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "create-service.html"));
});

app.get("/manage-services", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "manage-services.html"));
});

app.get("/service", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "service.html"));
});

app.get("/support", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "support.html"));
});

app.get("/ticket", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "ticket.html"));
});

app.get("/admin", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* =========================
   STRIPE CHECKOUT
========================= */

app.post("/create-checkout-session", requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    const selectedPlan = getPlanDetails(plan);

    if (!selectedPlan || !selectedPlan.stripePriceId) {
      return res.redirect("/checkout?error=invalid_plan");
    }

    const user = await getUserById(req.session.user.id);

    if (!user) {
      return res.redirect("/login.html?error=account_not_found");
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: selectedPlan.stripePriceId,
          quantity: 1
        }
      ],
      success_url: `${BASE_URL}/dashboard?success=stripe_redirect`,
      cancel_url: `${BASE_URL}/checkout?error=canceled`,
      client_reference_id: String(user.id),
      customer_email: user.email,
      metadata: {
        userId: String(user.id),
        planKey: selectedPlan.key
      }
    });

    await runQuery(
      `
      INSERT INTO checkout_sessions (
        user_id,
        stripe_session_id,
        plan_key,
        price_id,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        user.id,
        checkoutSession.id,
        selectedPlan.key,
        selectedPlan.stripePriceId,
        "pending",
        new Date().toISOString()
      ]
    );

    return res.redirect(303, checkoutSession.url);
  } catch (error) {
    console.error("ERRO create-checkout-session:", error);
    return res.redirect("/checkout?error=server_error");
  }
});

app.post("/checkout", requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    const selectedPlan = getPlanDetails(plan);

    if (!selectedPlan || !selectedPlan.stripePriceId) {
      return res.redirect("/checkout?error=invalid_plan");
    }

    const user = await getUserById(req.session.user.id);

    if (!user) {
      return res.redirect("/login.html?error=account_not_found");
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: selectedPlan.stripePriceId,
          quantity: 1
        }
      ],
      success_url: `${BASE_URL}/dashboard?success=stripe_redirect`,
      cancel_url: `${BASE_URL}/checkout?error=canceled`,
      client_reference_id: String(user.id),
      customer_email: user.email,
      metadata: {
        userId: String(user.id),
        planKey: selectedPlan.key
      }
    });

    await runQuery(
      `
      INSERT INTO checkout_sessions (
        user_id,
        stripe_session_id,
        plan_key,
        price_id,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        user.id,
        checkoutSession.id,
        selectedPlan.key,
        selectedPlan.stripePriceId,
        "pending",
        new Date().toISOString()
      ]
    );

    return res.redirect(303, checkoutSession.url);
  } catch (error) {
    console.error("ERRO checkout:", error);
    return res.redirect("/checkout?error=server_error");
  }
});

/* =========================
   BILLING DE VERDADE
========================= */

app.post("/create-customer-portal-session", requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.session.user.id);

    if (!user || !user.stripe_customer_id) {
      return res.redirect("/billing?error=no_stripe_customer");
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${BASE_URL}/billing`
    });

    return res.redirect(303, portalSession.url);
  } catch (error) {
    console.error("ERRO billing portal:", error);
    return res.redirect("/billing?error=server_error");
  }
});

app.post("/cancel-subscription-direct", requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.session.user.id);

    if (!user || !user.stripe_subscription_id) {
      return res.redirect("/billing?error=no_subscription");
    }

    await stripe.subscriptions.cancel(user.stripe_subscription_id);

    await runQuery(
      `
      UPDATE users
      SET active_plan = NULL,
          payment_method = 'Stripe',
          payment_summary = 'Subscription canceled',
          stripe_subscription_id = NULL
      WHERE id = ?
      `,
      [user.id]
    );

    return res.redirect("/billing?success=subscription_canceled");
  } catch (error) {
    console.error("ERRO cancel-subscription-direct:", error);
    return res.redirect("/billing?error=server_error");
  }
});

app.post("/change-subscription-plan", requireAuth, async (req, res) => {
  try {
    const { planKey } = req.body;
    const selectedPlan = getPlanDetails(planKey);

    if (!selectedPlan || !selectedPlan.stripePriceId) {
      return res.redirect("/billing?error=invalid_plan");
    }

    const user = await getUserById(req.session.user.id);

    if (!user || !user.stripe_subscription_id) {
      return res.redirect("/billing?error=no_subscription");
    }

    const subscription = await stripe.subscriptions.retrieve(
      user.stripe_subscription_id
    );

    if (!subscription.items?.data?.length) {
      return res.redirect("/billing?error=no_subscription_items");
    }

    const currentPriceId = subscription.items.data[0]?.price?.id || null;

    if (currentPriceId === selectedPlan.stripePriceId) {
      return res.redirect("/billing?success=plan_already_active");
    }

    const subscriptionItemId = subscription.items.data[0].id;

    const updatedSubscription = await stripe.subscriptions.update(
      user.stripe_subscription_id,
      {
        items: [
          {
            id: subscriptionItemId,
            price: selectedPlan.stripePriceId
          }
        ],
        proration_behavior: "create_prorations"
      }
    );

    await runQuery(
      `
      UPDATE users
      SET active_plan = ?,
          payment_method = ?,
          payment_summary = ?,
          stripe_subscription_id = ?
      WHERE id = ?
      `,
      [
        selectedPlan.key,
        "Stripe",
        `Subscription status: ${updatedSubscription.status} - ${selectedPlan.name} Plan`,
        updatedSubscription.id,
        user.id
      ]
    );

    await runQuery(
      `
      INSERT INTO invoices (
        user_id,
        invoice_number,
        description,
        amount,
        status,
        payment_method,
        issue_date,
        renewal_date
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        user.id,
        `INV-CHANGE-${Date.now()}`,
        `Plan changed to ${selectedPlan.name}`,
        `$${selectedPlan.amount}`,
        "Updated",
        "Stripe",
        formatDate(),
        nextRenewalDate()
      ]
    );

    return res.redirect("/billing?success=plan_changed");
  } catch (error) {
    console.error("ERRO change-subscription-plan:", error);
    return res.redirect("/billing?error=server_error");
  }
});

/* =========================
   SERVICES
========================= */

app.post("/create-service", requireAuth, async (req, res) => {
  try {
    const { serviceName, runtime, region } = req.body;

    if (!serviceName || !runtime || !region) {
      return res.redirect("/create-service?error=empty_fields");
    }

    const user = await getUserById(req.session.user.id);

    if (!user || !user.active_plan) {
      return res.redirect("/dashboard?error=no_plan");
    }

    const plan = getPlanDetails(user.active_plan);
    const currentServices = await getServicesByUserId(user.id);

    if (!plan || currentServices.length >= plan.serviceLimit) {
      return res.redirect("/create-service?error=plan_limit_reached");
    }

    const result = await runQuery(
      `
      INSERT INTO services (
        user_id,
        name,
        runtime,
        region,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        user.id,
        serviceName.trim(),
        runtime.trim(),
        region.trim(),
        "Online",
        new Date().toISOString()
      ]
    );

    await createServiceLog(result.lastID, "Service created and started.");

    return res.redirect("/dashboard?success=service_created");
  } catch (error) {
    console.error(error);
    return res.redirect("/create-service?error=server_error");
  }
});

app.post("/service-action", requireAuth, async (req, res) => {
  try {
    const { serviceId, action, returnTo } = req.body;

    const service = await getQuery(
      "SELECT * FROM services WHERE id = ? AND user_id = ?",
      [serviceId, req.session.user.id]
    );

    if (!service) {
      return res.redirect("/manage-services?error=service_not_found");
    }

    if (action === "start") {
      await runQuery("UPDATE services SET status = ? WHERE id = ?", ["Online", serviceId]);
      await createServiceLog(serviceId, "Service started.");
    } else if (action === "stop") {
      await runQuery("UPDATE services SET status = ? WHERE id = ?", ["Offline", serviceId]);
      await createServiceLog(serviceId, "Service stopped.");
    } else if (action === "restart") {
      await runQuery("UPDATE services SET status = ? WHERE id = ?", ["Online", serviceId]);
      await createServiceLog(serviceId, "Service restarted.");
    } else if (action === "delete") {
      await createServiceLog(serviceId, "Service deleted.");
      await runQuery("DELETE FROM services WHERE id = ?", [serviceId]);
    }

    if (returnTo === "service") {
      return res.redirect(`/service?id=${serviceId}&success=action_done`);
    }

    return res.redirect("/manage-services?success=service_updated");
  } catch (error) {
    console.error(error);
    return res.redirect("/manage-services?error=server_error");
  }
});

/* =========================
   SUPPORT
========================= */

app.post("/support/create", requireAuth, async (req, res) => {
  try {
    const { subject, message } = req.body;

    if (!subject || !message) {
      return res.redirect("/support?error=empty_fields");
    }

    const ticketResult = await runQuery(
      `
      INSERT INTO tickets (user_id, subject, status, created_at)
      VALUES (?, ?, ?, ?)
      `,
      [req.session.user.id, subject.trim(), "Open", new Date().toISOString()]
    );

    await runQuery(
      `
      INSERT INTO ticket_messages (ticket_id, sender_role, message, created_at)
      VALUES (?, ?, ?, ?)
      `,
      [ticketResult.lastID, "User", message.trim(), new Date().toISOString()]
    );

    return res.redirect(`/ticket?id=${ticketResult.lastID}&success=ticket_created`);
  } catch (error) {
    console.error(error);
    return res.redirect("/support?error=server_error");
  }
});

app.post("/ticket/reply", requireAuth, async (req, res) => {
  try {
    const { ticketId, message } = req.body;

    if (!message) {
      return res.redirect(`/ticket?id=${ticketId}&error=empty_fields`);
    }

    const ticket = await getQuery(
      "SELECT * FROM tickets WHERE id = ? AND user_id = ?",
      [ticketId, req.session.user.id]
    );

    if (!ticket) {
      return res.redirect("/support?error=ticket_not_found");
    }

    await runQuery(
      `
      INSERT INTO ticket_messages (ticket_id, sender_role, message, created_at)
      VALUES (?, ?, ?, ?)
      `,
      [ticketId, "User", message.trim(), new Date().toISOString()]
    );

    return res.redirect(`/ticket?id=${ticketId}&success=reply_sent`);
  } catch (error) {
    console.error(error);
    return res.redirect("/support?error=server_error");
  }
});

/* =========================
   ADMIN
========================= */

app.post("/admin/delete-user", requireAuth, async (req, res) => {
  try {
    const { userId } = req.body;

    await runQuery("DELETE FROM users WHERE id = ?", [userId]);

    if (String(req.session.user.id) === String(userId)) {
      return req.session.destroy(() => {
        res.redirect("/login.html?success=logged_out");
      });
    }

    return res.redirect("/admin?success=user_deleted");
  } catch (error) {
    console.error(error);
    return res.redirect("/admin?error=server_error");
  }
});

app.post("/admin/change-plan", requireAuth, async (req, res) => {
  try {
    const { userId, planKey } = req.body;
    const selectedPlan = getPlanDetails(planKey);

    if (!selectedPlan) {
      return res.redirect("/admin?error=invalid_plan");
    }

    await runQuery("UPDATE users SET active_plan = ? WHERE id = ?", [
      selectedPlan.key,
      userId
    ]);

    return res.redirect("/admin?success=plan_changed");
  } catch (error) {
    console.error(error);
    return res.redirect("/admin?error=server_error");
  }
});

/* =========================
   API
========================= */

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.session.user.id);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const services = await getServicesByUserId(user.id);
    const invoices = await getInvoicesByUserId(user.id);
    const tickets = await allQuery(
      "SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC",
      [user.id]
    );

    const onlineServices = services.filter((s) => s.status === "Online");
    const cpuUsage = onlineServices.length > 0 ? Math.min(onlineServices.length * 8, 100) : 0;
    const memoryUsageValue = onlineServices.length > 0
      ? (onlineServices.length * 0.4).toFixed(1)
      : "0.0";

    return res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      activePlan: user.active_plan ? getPlanDetails(user.active_plan) : null,
      paymentMethod: user.payment_method,
      paymentSummary: user.payment_summary,
      stripeCustomerId: user.stripe_customer_id,
      stripeSubscriptionId: user.stripe_subscription_id,
      services,
      invoices,
      tickets,
      cpuUsage,
      memoryUsage: `${memoryUsageValue} GB`
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/service", requireAuth, async (req, res) => {
  try {
    const { id } = req.query;

    const service = await getQuery(
      "SELECT * FROM services WHERE id = ? AND user_id = ?",
      [id, req.session.user.id]
    );

    if (!service) {
      return res.status(404).json({ error: "Service not found" });
    }

    const logs = await getLogsByServiceId(service.id);

    return res.json({ service, logs });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/tickets", requireAuth, async (req, res) => {
  try {
    const tickets = await allQuery(
      "SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC",
      [req.session.user.id]
    );

    return res.json(tickets);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/ticket", requireAuth, async (req, res) => {
  try {
    const { id } = req.query;

    const ticket = await getQuery(
      "SELECT * FROM tickets WHERE id = ? AND user_id = ?",
      [id, req.session.user.id]
    );

    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    const messages = await allQuery(
      "SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC",
      [id]
    );

    return res.json({ ticket, messages });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/admin/users", requireAuth, async (req, res) => {
  try {
    const users = await allQuery(
      `
      SELECT
        u.id,
        u.username,
        u.email,
        u.active_plan,
        u.payment_method,
        COUNT(DISTINCT s.id) AS servicesCount,
        COUNT(DISTINCT i.id) AS invoicesCount,
        COUNT(DISTINCT t.id) AS ticketsCount
      FROM users u
      LEFT JOIN services s ON s.user_id = u.id
      LEFT JOIN invoices i ON i.user_id = u.id
      LEFT JOIN tickets t ON t.user_id = u.id
      GROUP BY u.id
      ORDER BY u.id DESC
      `
    );

    const mappedUsers = users.map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      activePlan: user.active_plan
        ? getPlanDetails(user.active_plan)?.name || "No plan"
        : "No plan",
      servicesCount: user.servicesCount || 0,
      invoicesCount: user.invoicesCount || 0,
      ticketsCount: user.ticketsCount || 0,
      paymentMethod: user.payment_method || "None"
    }));

    return res.json(mappedUsers);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log("SERVER STRIPE + SQLITE + BCRYPT RODANDO");
  console.log(`Servidor rodando em ${BASE_URL}`);
});