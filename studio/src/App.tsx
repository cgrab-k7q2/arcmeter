import { MeterProvider } from '@/context/MeterContext'
import { AppHeader } from '@/components/AppHeader'
import { OpenChannelCard } from '@/components/OpenChannelCard'
import { PayPerCallCard } from '@/components/PayPerCallCard'
import { ServiceCard } from '@/components/ServiceCard'
import { StatusCard } from '@/components/StatusCard'

export default function App() {
  return (
    <MeterProvider>
      <div className="mx-auto min-h-dvh max-w-5xl px-4 py-8 pb-24 sm:px-6">
        <AppHeader />
        <main className="grid gap-5 md:grid-cols-2">
          <div className="space-y-5">
            <OpenChannelCard />
            <PayPerCallCard />
          </div>
          <div className="space-y-5">
            <ServiceCard />
            <StatusCard />
          </div>
        </main>
      </div>
    </MeterProvider>
  )
}
