import { useNavigate } from 'react-router-dom'
import { Compass, FileArchive, LayoutDashboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/drive/PageHeader'

export function NotFoundPage() {
  const navigate = useNavigate()

  return (
    <>
      <PageHeader title="Page not found" description="The page you are looking for does not exist or has moved." />
      <Card className="mt-8 p-10 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
          <Compass className="h-7 w-7" />
        </div>
        <p className="mt-4 text-4xl font-extrabold tracking-tight text-slate-900">404</p>
        <p className="mt-2 text-sm text-slate-500">Check the address, or head back to your workspace.</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={() => navigate('/dashboard')}><LayoutDashboard className="h-4 w-4" />Go to Dashboard</Button>
          <Button variant="outline" onClick={() => navigate('/all-files')}><FileArchive className="h-4 w-4" />Open All Files</Button>
        </div>
      </Card>
    </>
  )
}
