export const metadata = { title: "Privacy notice" };
/** Layered privacy notice — DRAFT. Requires legal/privacy counsel review before production (spec §37). */
export default function PrivacyNotice() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-10 leading-relaxed">
      <p className="mb-2 rounded-xl bg-caution-bg p-3 text-sm font-semibold text-caution">Draft notice — requires legal/privacy counsel review before production use.</p>
      <h1 className="mb-4 text-3xl font-extrabold">Privacy notice</h1>
      <h2 className="mt-6 text-xl font-bold">What we collect</h2>
      <p>Your name and email or phone number; your baby&apos;s details (name, date and time of birth, sex, birth measurements, gestational age); records you choose to add: feeds, measurements, vaccinations, appointments, prescriptions, medicines, allergies, documents and notes; and security logs (sign-ins, changes, document access).</p>
      <h2 className="mt-6 text-xl font-bold">Why</h2>
      <p>Only to provide the record-keeping service to you and the people you invite: storing and showing records, reminders you set up, summaries and exports. We do not sell data, show advertising, or track or profile children.</p>
      <h2 className="mt-6 text-xl font-bold">Consent</h2>
      <p>As the parent or lawful guardian you give consent on your child&apos;s behalf. Optional purposes (analytics, SMS reminders) are off unless you turn them on, and you can withdraw any consent in Settings → Privacy as easily as you gave it.</p>
      <h2 className="mt-6 text-xl font-bold">Where and how it is stored</h2>
      <p>On servers in India, encrypted in transit and at rest. Documents are kept in private storage and opened only through short-lived links. Access is limited to the people you invite, according to the role you choose.</p>
      <h2 className="mt-6 text-xl font-bold">Your rights</h2>
      <p>You can access, correct, export and delete your data from the app. Deletion is permanent after a 30-day recovery window; security logs are retained for at least one year as required for investigating security incidents.</p>
      <h2 className="mt-6 text-xl font-bold">Service providers</h2>
      <p>Cloud hosting and storage (India region), email/SMS delivery for sign-in codes and reminders, and push notification services (which never receive health details).</p>
      <h2 className="mt-6 text-xl font-bold">Medical information</h2>
      <p>This app records information and shows sourced reference guidance. It does not diagnose, treat or recommend medicines, and it is not a substitute for your pediatrician.</p>
      <h2 className="mt-6 text-xl font-bold">Contact &amp; grievances</h2>
      <p>Write to the grievance officer at the contact shown in Settings → Privacy. We aim to respond within 30 days.</p>
    </main>
  );
}
